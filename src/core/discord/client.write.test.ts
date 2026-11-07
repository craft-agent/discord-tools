import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { WRITE_TIMEOUT_MS } from "./client"
import { type Harness, createHarness } from "./client.testing"
import type { ErrorCode } from "../errors"
import { TransportFailure } from "./transport"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(() => harness.dispose())

const send = () => harness.client.write("POST", "/channels/2/messages", { body: { content: "hi" } })

describe("a write", () => {
  test("returns what Discord answered, with a 30 second limit", async () => {
    harness.discord.route("POST", "/channels/2/messages", { status: 200, json: { id: "9" } })
    expect(await send()).toEqual({ id: "9" })
    expect(harness.discord.api[0]!.timeoutMs).toBe(WRITE_TIMEOUT_MS)
  })

  test("accepts an empty 204", async () => {
    harness.discord.route("PUT", "/channels/2/pins/9", { status: 204 })
    expect(await harness.client.write("PUT", "/channels/2/pins/9")).toBeUndefined()
  })

  test("is uncertain when the answer is empty or not JSON, unless it is a 204", async () => {
    for (const answer of [
      { status: 200 },
      { status: 201 },
      { status: 200, text: "<html>ok</html>" },
      { status: 204, text: "?" },
    ]) {
      harness.discord.route("POST", "/channels/2/messages", answer)
      await expect(send()).rejects.toMatchObject({ code: "uncertain" })
    }
  })

  test("is uncertain after a server error, and is not retried", async () => {
    for (const status of [500, 502, 503, 504]) {
      harness.discord.route("POST", "/channels/2/messages", { status, json: { message: "oops" } })
      const before = harness.discord.api.length
      await expect(send()).rejects.toMatchObject({ code: "uncertain", message: expect.stringContaining(`${status}`) })
      expect(harness.discord.api).toHaveLength(before + 1)
    }
  })

  test("is uncertain after an answer that is neither success nor refusal", async () => {
    harness.discord.route("POST", "/channels/2/messages", { status: 302, headers: { location: "/x" } })
    await expect(send()).rejects.toMatchObject({ code: "uncertain" })
  })

  test("throws the code of a refusal, which changed nothing", async () => {
    const cases: [number, unknown, ErrorCode][] = [
      [400, { code: 50035, message: "Invalid Form Body" }, "invalid_argument"],
      [403, { code: 50013, message: "Missing Permissions" }, "forbidden"],
      [404, { code: 10003, message: "Unknown Channel" }, "not_found"],
      [400, { captcha_key: ["captcha-required"] }, "forbidden"],
      [401, { code: 60003 }, "forbidden"],
      [409, {}, "upstream_error"],
    ]
    for (const [status, json, code] of cases) {
      harness.discord.route("POST", "/channels/2/messages", { status, json })
      await expect(send()).rejects.toMatchObject({ code })
    }
  })

  test("is rate_limited on a 429, without waiting or retrying", async () => {
    harness.discord.route("POST", "/channels/2/messages", { status: 429, json: { retry_after: 1.2 } })
    await expect(send()).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("retry after 2s"),
    })
    expect(harness.discord.api).toHaveLength(1)
    expect(harness.sleeps).toEqual([1100])
  })
})

describe("a write that fails below HTTP", () => {
  beforeEach(() => harness.warm())

  test("is uncertain when the request may have left, and is not retried", async () => {
    harness.discord.failNext({ dispatched: true, message: "operation timed out" })
    const error = await send().catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: "uncertain",
      message: "The request may have reached Discord; check before trying again.",
    })
    expect(harness.discord.api).toHaveLength(1)
  })

  test("is upstream_error, saying nothing was sent, when it cannot have left", async () => {
    harness.discord.failNext({ dispatched: false, message: "connection refused" })
    await expect(send()).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("nothing was sent"),
    })
    expect(harness.discord.api).toHaveLength(1)
  })

  test("is uncertain when it aborts after sending", async () => {
    const controller = new AbortController()
    const writing = harness.another({
      transport: async (request) => {
        if (!request.url.includes("/api/")) return harness.discord.transport(request)
        controller.abort()
        throw new TransportFailure("cancelled", true)
      },
    })
    await expect(writing.write("POST", "/channels/2/messages", { signal: controller.signal })).rejects.toMatchObject({
      code: "uncertain",
    })
  })

  test("throws the abort, sending nothing, when its signal aborted beforehand", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      harness.client.write("POST", "/channels/2/messages", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(harness.discord.api).toHaveLength(0)
  })

  test("treats an error that is not a transport failure as possibly sent", async () => {
    const writing = harness.another({
      transport: async (request) => {
        if (!request.url.includes("/api/")) return harness.discord.transport(request)
        throw new Error("something odd")
      },
    })
    await expect(writing.write("POST", "/channels/2/messages")).rejects.toMatchObject({ code: "uncertain" })
  })
})
