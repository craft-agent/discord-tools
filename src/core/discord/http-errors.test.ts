import { describe, expect, test } from "bun:test"
import { fakeToken } from "./fake-token.testing"
import { httpError, parseJson, requiresTwoFactor, retryAfter } from "./http-errors"

const TOKEN = fakeToken()

describe("httpError", () => {
  test("maps statuses to codes, with Discord's code and message", () => {
    const body = { code: 10003, message: "Unknown Channel" }
    const cases: [number, string][] = [
      [400, "invalid_argument"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "upstream_error"],
      [500, "upstream_error"],
      [503, "upstream_error"],
    ]
    for (const [status, code] of cases) {
      const error = httpError(status, {}, body)
      expect(error.code).toBe(code as typeof error.code)
      expect(error.message).toBe(`Discord answered ${status} (code 10003): Unknown Channel`)
    }
  })

  test("says what it can without a code or message", () => {
    expect(httpError(502, {}, "<html>bad gateway</html>").message).toBe("Discord answered 502")
    expect(httpError(404, {}, undefined).message).toBe("Discord answered 404")
  })

  test("maps a 401 to a rejected token", () => {
    const error = httpError(401, {}, { code: 0, message: "401: Unauthorized" })
    expect(error.code).toBe("unauthenticated")
    expect(error.message).toBe("Discord rejected the token (401); give this account a new token.")
  })

  test("maps a two-factor challenge to forbidden, not to a rejected token", () => {
    for (const body of [
      { code: 60003, message: "Two factor is required" },
      { mfa: { ticket: "t" }, message: "x" },
    ]) {
      const error = httpError(401, {}, body)
      expect(error.code).toBe("forbidden")
      expect(error.message).toBe(
        "Discord asked for two-factor verification for this action; nothing was done. Do it in the Discord app.",
      )
    }
  })

  test("maps a captcha to forbidden", () => {
    const error = httpError(400, {}, { captcha_key: ["captcha-required"] })
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe("Discord asked for a captcha; do it in the Discord app.")
  })

  test("maps a 429 to rate_limited with the wait", () => {
    const error = httpError(429, {}, { retry_after: 2.4, message: "You are being rate limited." })
    expect(error.code).toBe("rate_limited")
    expect(error.message).toContain("retry after 3s")
    expect(httpError(429, { "retry-after": "7" }, undefined).message).toContain("retry after 7s")
  })

  test("masks tokens in Discord's message, given or not", () => {
    const echoed = { code: 50035, message: `Invalid token ${TOKEN}` }
    expect(httpError(400, {}, echoed).message).toBe("Discord answered 400 (code 50035): Invalid token <token>")
    const odd = { message: "bad plain-user-token" }
    expect(httpError(400, {}, odd, "plain-user-token").message).toBe("Discord answered 400: bad <token>")
  })

  test("cuts a long message", () => {
    expect(httpError(400, {}, { message: "x".repeat(1000) }).message.length).toBeLessThan(400)
  })
})

describe("requiresTwoFactor", () => {
  test("is a 401 with the two-factor code or an mfa body", () => {
    expect(requiresTwoFactor(401, { code: 60003 })).toBe(true)
    expect(requiresTwoFactor(401, { mfa: { ticket: "t" } })).toBe(true)
    expect(requiresTwoFactor(401, { code: 0 })).toBe(false)
    expect(requiresTwoFactor(401, undefined)).toBe(false)
    expect(requiresTwoFactor(403, { code: 60003 })).toBe(false)
  })
})

describe("retryAfter", () => {
  test("prefers the body, then the header, then 5 seconds", () => {
    expect(retryAfter({ "retry-after": "9" }, { retry_after: 1.5 })).toBe(1.5)
    expect(retryAfter({ "retry-after": "9" }, {})).toBe(9)
    expect(retryAfter({}, undefined)).toBe(5)
    expect(retryAfter({ "retry-after": "soon" }, "text")).toBe(5)
    expect(retryAfter({}, { retry_after: "2" })).toBe(5)
  })
})

describe("parseJson", () => {
  test("parses JSON and gives undefined for empty or other text", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson("null")).toBeNull()
    expect(parseJson("")).toBeUndefined()
    expect(parseJson("  ")).toBeUndefined()
    expect(parseJson("<html>")).toBeUndefined()
  })
})
