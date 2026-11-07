import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { READ_TIMEOUT_MS } from "./client"
import { type Harness, createHarness } from "./client.testing"
import type { ErrorCode } from "../errors"
import { TransportFailure } from "./transport"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(() => harness.dispose())

const read = () => harness.client.read("GET", "/users/@me")

describe("a read", () => {
  test("returns the parsed answer, with a 20 second limit", async () => {
    harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1", username: "ada" } })
    expect(await read()).toEqual({ id: "1", username: "ada" })
    expect(harness.discord.api[0]!.timeoutMs).toBe(READ_TIMEOUT_MS)
  })

  test("returns undefined for an empty answer and refuses one that is not JSON", async () => {
    harness.discord.route("GET", "/users/@me", [{ status: 204 }, { status: 200, text: "<html>" }])
    expect(await read()).toBeUndefined()
    await expect(read()).rejects.toMatchObject({ code: "upstream_error" })
  })

  test("can send a body, as a search does", async () => {
    harness.discord.route("POST", "/search", (request) => ({ status: 200, json: { echoed: request.body } }))
    expect(await harness.client.read("POST", "/search", { body: { q: "x" } })).toEqual({ echoed: '{"q":"x"}' })
  })

  test("maps every refusal to its code", async () => {
    const cases: [number, unknown, ErrorCode][] = [
      [400, { code: 50035, message: "Invalid Form Body" }, "invalid_argument"],
      [403, { code: 50001, message: "Missing Access" }, "forbidden"],
      [404, { code: 10003, message: "Unknown Channel" }, "not_found"],
      [400, { captcha_key: ["captcha-required"] }, "forbidden"],
      [401, { code: 60003, message: "mfa" }, "forbidden"],
      [409, {}, "upstream_error"],
      [500, {}, "upstream_error"],
      [502, "bad gateway", "upstream_error"],
    ]
    for (const [status, json, code] of cases) {
      harness.discord.route("GET", "/users/@me", typeof json === "string" ? { status, text: json } : { status, json })
      await expect(read()).rejects.toMatchObject({ code })
    }
  })

  test("carries Discord's code and message", async () => {
    harness.discord.route("GET", "/users/@me", { status: 404, json: { code: 10003, message: "Unknown Channel" } })
    await expect(read()).rejects.toThrow("Discord answered 404 (code 10003): Unknown Channel")
  })

  test("is never uncertain when the connection fails", async () => {
    for (const dispatched of [true, false]) {
      harness.discord.failNext({ dispatched })
      await expect(read()).rejects.toMatchObject({ code: "upstream_error" })
    }
  })

  test("throws the abort when its signal aborted, sending nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(harness.client.read("GET", "/users/@me", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(harness.discord.api).toHaveLength(0)
  })

  test("throws the abort when it aborts while the request is out", async () => {
    const controller = new AbortController()
    const reading = harness.another({
      transport: async (request) => {
        if (!request.url.includes("/api/")) return harness.discord.transport(request)
        controller.abort()
        throw new TransportFailure("cancelled", true)
      },
    })
    await expect(reading.read("GET", "/users/@me", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})

describe("a rate limit on a read", () => {
  test("is waited out once, with a little extra, and then the read succeeds", async () => {
    harness.discord.route("GET", "/users/@me", [
      { status: 429, json: { retry_after: 2, message: "You are being rate limited." } },
      { status: 200, json: { id: "1" } },
    ])
    expect(await read()).toEqual({ id: "1" })
    expect(harness.discord.api).toHaveLength(2)
    // The first pacing wait, then 2 s + 0.2 s + 0.5 * 0.6 s for the rate limit, which also covers the pacing.
    expect(harness.sleeps).toEqual([1100, 2500])
  })

  test("reads the wait from the header when the body has none", async () => {
    harness.discord.route("GET", "/users/@me", [
      { status: 429, headers: { "retry-after": "3" } },
      { status: 200, json: { id: "1" } },
    ])
    await read()
    expect(harness.sleeps).toContain(3500)
  })

  test("is rate_limited the second time", async () => {
    harness.discord.route("GET", "/users/@me", { status: 429, json: { retry_after: 1 } })
    await expect(read()).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("retry after 1s"),
    })
    expect(harness.discord.api).toHaveLength(2)
  })

  test("is rate_limited at once when it asks for more than 30 seconds", async () => {
    harness.discord.route("GET", "/users/@me", { status: 429, json: { retry_after: 31 } })
    await expect(read()).rejects.toMatchObject({ code: "rate_limited" })
    expect(harness.discord.api).toHaveLength(1)
  })

  test("is waited out when it asks for exactly 30 seconds", async () => {
    harness.discord.route("GET", "/users/@me", [
      { status: 429, json: { retry_after: 30 } },
      { status: 200, json: {} },
    ])
    await read()
    expect(harness.sleeps).toContain(30_500)
  })
})

describe("a search index still being built", () => {
  const indexing = { status: 202, json: { code: 110000, message: "Index not yet available.", retry_after: 4 } }

  test("is waited out once", async () => {
    harness.discord.route("GET", "/users/@me", [indexing, { status: 200, json: { total_results: 0 } }])
    expect(await read()).toEqual({ total_results: 0 })
    expect(harness.sleeps).toContain(4500)
  })

  test("waits 5 seconds when Discord names no wait", async () => {
    harness.discord.route("GET", "/users/@me", [
      { status: 202, json: { code: 110000 } },
      { status: 200, json: {} },
    ])
    await read()
    expect(harness.sleeps).toContain(5500)
  })

  test("is rate_limited when it is still being built after the wait", async () => {
    harness.discord.route("GET", "/users/@me", indexing)
    await expect(read()).rejects.toMatchObject({
      code: "rate_limited",
      message: "Discord is still indexing this search; try again in a minute",
    })
    expect(harness.discord.api).toHaveLength(2)
  })

  test("is rate_limited at once when the wait is too long", async () => {
    harness.discord.route("GET", "/users/@me", { status: 202, json: { code: 110000, retry_after: 90 } })
    await expect(read()).rejects.toMatchObject({ code: "rate_limited" })
    expect(harness.discord.api).toHaveLength(1)
  })

  test("is only waited out once for a limit and an index together", async () => {
    harness.discord.route("GET", "/users/@me", [{ status: 429, json: { retry_after: 1 } }, indexing])
    await expect(read()).rejects.toMatchObject({ code: "rate_limited" })
    expect(harness.discord.api).toHaveLength(2)
  })

  test("is not an index when the code differs", async () => {
    harness.discord.route("GET", "/users/@me", { status: 202, json: { code: 1, queued: true } })
    expect(await read()).toEqual({ code: 1, queued: true })
  })
})
