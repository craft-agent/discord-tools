import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { FAKE_TOKEN } from "../discord/client.testing"
import { TransportFailure } from "../discord/transport"
import { UPLOADS_TIMEOUT_MS } from "./upload"
import { RESERVE_PATH, createUploadFixture, slotOf, storageUrlOf, type UploadFixture } from "./upload.testing"

let f: UploadFixture

beforeEach(async () => {
  f = await createUploadFixture()
})

afterEach(() => f.dispose())

const NOT_RESERVED = "Discord did not reserve upload slots; no message was sent."

describe("a reservation that fails", () => {
  test("propagates what Discord refused, with no upload", async () => {
    f.harness.discord.route("POST", RESERVE_PATH, {
      status: 403,
      json: { code: 50013, message: "Missing Permissions" },
    })
    const files = await f.prepare(["a"])
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({ code: "forbidden" })
    expect(f.puts()).toHaveLength(0)
  })

  test("is upstream_error when it may have reached Discord, and nothing is uploaded", async () => {
    const files = await f.prepare(["a"])
    f.harness.discord.route("POST", RESERVE_PATH, { status: 500, text: "oops" })
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({ code: "upstream_error", message: NOT_RESERVED })
    f.harness.discord.failNext({ dispatched: true })
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({ code: "upstream_error", message: NOT_RESERVED })
    expect(f.puts()).toHaveLength(0)
  })

  test("is upstream_error when the answer is broken", async () => {
    const files = await f.prepare(["a"])
    for (const answer of [
      { status: 200, text: "not json" },
      { status: 200, json: {} },
      { status: 200, json: { attachments: "x" } },
      { status: 200, json: [] },
    ]) {
      f.harness.discord.route("POST", RESERVE_PATH, answer)
      expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({ code: "upstream_error" })
    }
    expect(f.puts()).toHaveLength(0)
  })
})

describe("a slot that is not usable", () => {
  const unusable: [string, unknown[]][] = [
    ["a URL that is not Discord's storage", [slotOf(0), slotOf(1, { upload_url: "https://evil.com/up/1/file.bin" })]],
    ["a plain http URL", [slotOf(0), slotOf(1, { upload_url: storageUrlOf(1).replace("https", "http") })]],
    ["no slot at all", [slotOf(0)]],
    ["an id that is not the file's", [slotOf(0), slotOf(7)]],
    ["the same id twice", [slotOf(0), slotOf(1), slotOf(1)]],
    ["a URL that is not a string", [slotOf(0), slotOf(1, { upload_url: 7 })]],
    ["no stored name", [slotOf(0), slotOf(1, { upload_filename: "" })]],
  ]

  test.each(unusable)("%s sends no upload for any file", async (_, attachments) => {
    f.harness.discord.route("POST", RESERVE_PATH, { status: 200, json: { attachments } })
    const files = await f.prepare(["a", "b"])
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({
      code: "upstream_error",
      message: "Discord returned no usable upload slot for f1.txt; no message was sent.",
    })
    expect(f.puts()).toHaveLength(0)
  })
})

describe("an upload that fails", () => {
  test("stops at the second file, naming it and why, with no further request", async () => {
    f.harness.discord.route("PUT", "/up/1/file.bin", { status: 403 })
    const files = await f.prepare(["a", "b", "c"])
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({
      code: "upstream_error",
      message: "f1.txt could not be uploaded (Discord's storage answered 403); no message was sent.",
    })
    expect(f.puts()).toHaveLength(2)
    expect(f.harness.discord.requests).toHaveLength(3)
  })

  test("is never retried, also on a transport failure, whose text holds no token", async () => {
    f.harness.discord.route("POST", RESERVE_PATH, { status: 200, json: { attachments: [slotOf(0)] } })
    const files = await f.prepare(["a"])
    const requestsBefore = f.harness.client.requests
    f.harness.discord.route("PUT", "/up/0/file.bin", () => {
      throw new TransportFailure(`reset ${FAKE_TOKEN}`, true)
    })
    const error = await f.outgoing.refusal(f.upload(files))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toStartWith("f0.txt could not be uploaded (")
    expect(error.message).not.toContain(FAKE_TOKEN)
    expect(f.puts()).toHaveLength(1)
    expect(f.harness.client.requests - requestsBefore).toBe(2)
  })
})

describe("a copy that is not what was checked", () => {
  test("is stale when its bytes changed to the same length, before anything is uploaded", async () => {
    const files = await f.prepare(["abc"])
    await writeFile(files[0]!.copy, "abd")
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({
      code: "stale",
      message: "f0.txt changed while it was being sent; nothing was sent.",
    })
    expect(f.puts()).toHaveLength(0)
  })

  test("is stale when its size changed, or the copy is gone", async () => {
    const files = await f.prepare(["abc", "def"])
    await writeFile(files[0]!.copy, "abcd")
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({ code: "stale" })
    await writeFile(files[0]!.copy, "abc")
    await rm(files[1]!.copy)
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({
      code: "stale",
      message: "f1.txt changed while it was being sent; nothing was sent.",
    })
    expect(f.puts()).toHaveLength(1)
  })
})

describe("time and cancellation", () => {
  test("uploads that take too long stop before the next file", async () => {
    f.harness.discord.route("PUT", "/up/0/file.bin", () => {
      f.harness.advance(UPLOADS_TIMEOUT_MS - 9000)
      return { status: 200 }
    })
    const files = await f.prepare(["a", "b"])
    expect(await f.outgoing.refusal(f.upload(files))).toMatchObject({
      code: "upstream_error",
      message: "The uploads took too long; no message was sent.",
    })
    expect(f.puts()).toHaveLength(1)
  })

  test("a cancelled signal sends nothing", async () => {
    const files = await f.prepare(["a"])
    await expect(f.upload(files, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" })
    expect(f.harness.discord.requests).toHaveLength(0)
  })

  test("cancelled while the reservation is out, the cancellation is what is thrown", async () => {
    const controller = new AbortController()
    f.harness.discord.route("POST", RESERVE_PATH, () => {
      controller.abort()
      return { status: 200, json: { attachments: [slotOf(0)] } }
    })
    const files = await f.prepare(["a"])
    await expect(f.upload(files, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(f.puts()).toHaveLength(0)
  })

  test("cancelled between two uploads, the second is not sent", async () => {
    const controller = new AbortController()
    f.harness.discord.route("PUT", "/up/0/file.bin", () => {
      controller.abort()
      return { status: 200 }
    })
    const files = await f.prepare(["a", "b"])
    await expect(f.upload(files, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(f.puts()).toHaveLength(1)
  })

  test("cancelled while an upload is out, the cancellation is what is thrown", async () => {
    const controller = new AbortController()
    f.harness.discord.route("PUT", "/up/0/file.bin", () => {
      controller.abort()
      throw new TransportFailure("cancelled", true)
    })
    const files = await f.prepare(["a"])
    await expect(f.upload(files, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })
})
