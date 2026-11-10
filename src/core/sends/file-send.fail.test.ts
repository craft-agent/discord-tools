import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { CHANNEL } from "../discord/objects.testing"
import { ATTACH_PATH, answerFileSends, createFileSendFixture, type FileSendFixture } from "./file-send.testing"
import { discordFileSend } from "./file-send-tool"
import { MESSAGES_PATH } from "./send.testing"
import { slotOf } from "./upload.testing"

let f: FileSendFixture

beforeEach(async () => {
  f = await createFileSendFixture()
  answerFileSends(f)
  await f.files.write("work/a.txt", "first")
  await f.files.write("work/b.txt", "second")
})

afterEach(() => f.dispose())

const send = (extra: Record<string, unknown> = {}) =>
  failure(f.sendFiles({ channel: CHANNEL, files: ["a.txt", "b.txt"], text: "hi", ...extra }))

/** Expects that nothing was posted and the ledger says so with `code`, and that no copy is left. */
async function expectNotSent(code: string) {
  expect(f.posted()).toEqual([])
  expect(f.ledger()).toMatchObject([{ status: "not_sent", message: null, code }])
  expect(f.readBacks()).toHaveLength(0)
  expect(await f.staged()).toEqual([])
}

describe("a file send whose upload fails", () => {
  test.each([
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ])("a reservation that Discord answers with %i is %s, and nothing is uploaded or posted", async (status, code) => {
    f.discord.route("POST", ATTACH_PATH, { status, json: { message: "no", retry_after: 1.5 } })
    expect(await send()).toMatchObject({ code })
    expect(f.reservations()).toHaveLength(1)
    expect(f.puts()).toHaveLength(0)
    await expectNotSent(code)
  })

  test("a reservation without usable slots is upstream_error", async () => {
    f.discord.route("POST", ATTACH_PATH, { status: 200, json: { attachments: [] } })
    expect(await send()).toMatchObject({ code: "upstream_error" })
    expect(f.puts()).toHaveLength(0)
    await expectNotSent("upstream_error")
  })

  test("an upload that fails stops the rest, posts nothing and is never retried", async () => {
    f.discord.route("PUT", "/up/0/file.bin", { status: 500 })
    expect(await send()).toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("no message was sent"),
    })
    expect(f.puts()).toHaveLength(1)
    await expectNotSent("upstream_error")
  })

  test("a later upload that fails leaves the earlier one unused", async () => {
    f.discord.route("PUT", "/up/1/file.bin", { status: 500 })
    expect(await send()).toMatchObject({ code: "upstream_error" })
    expect(f.puts()).toHaveLength(2)
    await expectNotSent("upstream_error")
  })

  test("a copy changed after it was checked is stale: nothing is uploaded or posted", async () => {
    f.discord.route("POST", ATTACH_PATH, () => {
      const [dir] = readdirSync(f.paths.outgoing)
      const copy = join(f.paths.outgoing, dir!, "02")
      writeFileSync(copy, "x".repeat(readFileSync(copy).length))
      return { status: 200, json: { attachments: [slotOf(0), slotOf(1)] } }
    })
    expect(await send()).toMatchObject({ code: "stale" })
    expect(f.puts()).toHaveLength(1)
    await expectNotSent("stale")
  })

  test("a call cancelled between uploads is cancelled in the ledger and posts nothing", async () => {
    const controller = new AbortController()
    f.discord.route("PUT", "/up/0/file.bin", () => {
      controller.abort()
      return { status: 200 }
    })
    const error = await discordFileSend
      .execute({ channel: CHANNEL, files: ["a.txt", "b.txt"] }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: "AbortError" })
    expect(f.puts()).toHaveLength(1)
    await expectNotSent("cancelled")
  })
})

describe("a file send that Discord refuses", () => {
  test.each([
    [400, "invalid_argument"],
    [403, "forbidden"],
    [429, "rate_limited"],
  ])("a message answered with %i is %s, settles not_sent and reads nothing back", async (status, code) => {
    f.discord.route("POST", MESSAGES_PATH, { status, json: { message: "no", retry_after: 1.5 } })
    expect(await send()).toMatchObject({ code })
    expect(f.puts()).toHaveLength(2)
    expect(f.posted()).toHaveLength(1)
    expect(f.ledger()).toMatchObject([{ status: "not_sent", message: null, code }])
    expect(f.readBacks()).toHaveLength(0)
    expect(await f.staged()).toEqual([])
  })
})
