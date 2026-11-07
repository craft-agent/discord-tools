import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { REQUEST_HEADER_ORDER } from "./client"
import { FAKE_TOKEN, type Harness, createHarness } from "./client.testing"
import { headerOf } from "./fake-discord.testing"
import { acceptLanguage, clientHints, discordLocale, locale, timeZone, userAgent } from "./identity"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
  harness.discord.route("POST", "/channels/2/messages", { status: 200, json: { id: "9" } })
})

afterEach(() => harness.dispose())

function names(request: { headers: [string, string][] }): string[] {
  return request.headers.map(([name]) => name)
}

describe("the headers of an API request", () => {
  test("come in the fixed order, without those that do not apply", async () => {
    await harness.client.read("GET", "/users/@me")
    const [request] = harness.discord.api
    const omitted = new Set(["content-type", "x-audit-log-reason", ...(timeZone() ? [] : ["x-discord-timezone"])])
    expect(names(request!)).toEqual(REQUEST_HEADER_ORDER.filter((name) => !omitted.has(name)))
  })

  test("carry the values of the claimed browser and the web client", async () => {
    await harness.client.read("GET", "/users/@me")
    const request = harness.discord.api[0]!
    const hints = clientHints("macos")
    const tag = discordLocale(locale())
    const expected: Record<string, string> = {
      "sec-ch-ua-platform": hints.platform,
      authorization: FAKE_TOKEN,
      "x-debug-options": "bugReporterEnabled",
      "sec-ch-ua": hints.ua,
      "sec-ch-ua-mobile": hints.mobile,
      "x-discord-locale": tag,
      "user-agent": userAgent("macos"),
      accept: "*/*",
      origin: "https://discord.com",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      referer: "https://discord.com/channels/@me",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": acceptLanguage(tag),
      priority: "u=1, i",
    }
    for (const [name, value] of Object.entries(expected)) expect(headerOf(request, name)).toBe(value)
    expect(headerOf(request, "x-discord-timezone")).toBe(timeZone())
  })

  test("describe the web client in the super properties", async () => {
    harness.discord.buildNumber = 424242
    await harness.client.read("GET", "/users/@me")
    const encoded = headerOf(harness.discord.api[0]!, "x-super-properties")!
    const properties = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>
    expect(properties).toMatchObject({
      os: "Mac OS X",
      client_build_number: 424242,
      system_locale: locale(),
      browser_user_agent: userAgent("macos"),
      client_app_state: "focused",
    })
  })

  test("claim Linux when the client does", async () => {
    const linux = harness.another({ os: "linux" })
    await linux.read("GET", "/users/@me")
    const request = harness.discord.api[0]!
    expect(headerOf(request, "sec-ch-ua-platform")).toBe('"Linux"')
    expect(headerOf(request, "user-agent")).toBe(userAgent("linux"))
  })

  test("name the page the request claims to come from", async () => {
    await harness.client.read("GET", "/users/@me", { referer: "/channels/1/2" })
    expect(headerOf(harness.discord.api[0]!, "referer")).toBe("https://discord.com/channels/1/2")
  })

  test("add the content type and the JSON for a body", async () => {
    await harness.client.write("POST", "/channels/2/messages", { body: { content: "hi", nonce: "7" } })
    const request = harness.discord.api[0]!
    expect(request.body).toBe('{"content":"hi","nonce":"7"}')
    expect(headerOf(request, "content-type")).toBe("application/json")
    expect(names(request).indexOf("content-type")).toBe(names(request).indexOf("user-agent") + 1)
  })

  test("add the audit log reason, encoded as the web client does", async () => {
    await harness.client.write("POST", "/channels/2/messages", { reason: "tidy up/é (old)!" })
    const request = harness.discord.api[0]!
    expect(headerOf(request, "x-audit-log-reason")).toBe("tidy up/%C3%A9 %28old%29%21")
    expect(names(request).indexOf("x-audit-log-reason")).toBe(names(request).indexOf("x-discord-locale") + 1)
  })
})

describe("the URL of an API request", () => {
  test("is under /api/v9, with the query that has a value", async () => {
    await harness.client.read("GET", "/users/@me", { query: { limit: 50, before: "123", skip: undefined, q: "a b" } })
    const [request] = harness.discord.api
    expect(request!.url).toBe("https://discord.com/api/v9/users/@me?limit=50&before=123&q=a+b")
    expect(request!.query.get("skip")).toBeNull()
  })
})

describe("the token", () => {
  test("is only in the authorization header of API requests", async () => {
    await harness.client.read("GET", "/users/@me")
    await harness.client.write("POST", "/channels/2/messages", { body: { content: "hi" }, reason: "why" })

    expect(harness.discord.login).toHaveLength(1)
    expect(harness.discord.login[0]!.navigation).toBe(true)
    for (const request of harness.discord.api) expect(request.navigation).toBeUndefined()
    expect(harness.discord.login[0]!.headers.map(([name]) => name)).not.toContain("authorization")
    for (const request of harness.discord.requests) {
      const rest = request.headers.filter(([name]) => name !== "authorization")
      expect(JSON.stringify([request.url, request.body, rest])).not.toContain(FAKE_TOKEN)
    }
    for (const request of harness.discord.api) expect(headerOf(request, "authorization")).toBe(FAKE_TOKEN)
  })
})

describe("the path", () => {
  const bad = ["users/@me", "https://evil.test/x", "/a/../b", "/a?x=1", "/a#b", "/a b", "/a\nb", ""]

  test("must be a plain path, or nothing is sent", async () => {
    for (const path of bad) {
      await expect(harness.client.read("GET", path)).rejects.toMatchObject({ code: "internal_error" })
      await expect(harness.client.write("POST", path)).rejects.toMatchObject({ code: "internal_error" })
    }
    expect(harness.discord.requests).toHaveLength(0)
    expect(harness.client.requests).toBe(0)
  })

  test("and the referer must be one", async () => {
    for (const referer of ["channels", "//evil.test", "/a\r\nx: y"]) {
      await expect(harness.client.read("GET", "/users/@me", { referer })).rejects.toMatchObject({
        code: "internal_error",
      })
    }
    expect(harness.discord.requests).toHaveLength(0)
  })
})
