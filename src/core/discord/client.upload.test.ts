import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BudgetSpent } from "./client"
import { FAKE_TOKEN, type Harness, createHarness } from "./client.testing"
import { acceptLanguage, clientHints, discordLocale, locale, userAgent } from "./identity"
import { UPLOAD_HEADER_ORDER } from "./request-headers"
import { TransportFailure } from "./transport"
import { isStorageUrl } from "./upload"

const STORAGE_URL = "https://discord-attachments-uploads-prd.storage.googleapis.com/abc/cat.png?upload_id=1&sig=2"
const STORAGE_PATH = "/abc/cat.png"
const REFERER = "/channels/1/2"
const TIMEOUT_MS = 120_000
const BYTES = Uint8Array.from([0, 1, 2, 255, 254, 128, 10, 13])

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  harness.discord.route("PUT", STORAGE_PATH, { status: 200 })
})

afterEach(() => harness.dispose())

function options(extra: Partial<Parameters<Harness["client"]["upload"]>[2]> = {}) {
  return { timeoutMs: TIMEOUT_MS, referer: REFERER, ...extra }
}

describe("an uploaded file", () => {
  test("arrives unchanged, in one PUT with the time limit", async () => {
    expect(await harness.client.upload(STORAGE_URL, BYTES, options({ timeoutMs: 5000 }))).toEqual({
      status: "uploaded",
    })
    expect(harness.discord.requests).toHaveLength(1)
    const [request] = harness.discord.requests
    expect(request).toMatchObject({ method: "PUT", url: STORAGE_URL, timeoutMs: 5000 })
    expect(Array.from(request!.bytes!)).toEqual(Array.from(BYTES))
  })

  test("is sent as the URL the check parsed", async () => {
    await harness.client.upload("https://B.STORAGE.googleapis.com:443/abc/cat.png#f", BYTES, options())
    expect(harness.discord.requests[0]!.url).toBe("https://b.storage.googleapis.com/abc/cat.png#f")
  })

  test("counts any 2xx answer as uploaded", async () => {
    harness.discord.route("PUT", STORAGE_PATH, { status: 204 })
    expect(await harness.client.upload(STORAGE_URL, BYTES, options())).toEqual({ status: "uploaded" })
  })
})

describe("the headers", () => {
  test("are Chrome's for a cross-site fetch from the web client, in order, with no content type", async () => {
    await harness.client.upload(STORAGE_URL, BYTES, options())
    const hints = clientHints("macos")
    const request = harness.discord.requests[0]!
    expect(request.headers).toEqual([
      ["sec-ch-ua-platform", hints.platform],
      ["sec-ch-ua", hints.ua],
      ["sec-ch-ua-mobile", hints.mobile],
      ["user-agent", userAgent("macos")],
      ["accept", "*/*"],
      ["origin", "https://discord.com"],
      ["sec-fetch-site", "cross-site"],
      ["sec-fetch-mode", "cors"],
      ["sec-fetch-dest", "empty"],
      ["referer", "https://discord.com/channels/1/2"],
      ["accept-encoding", "gzip, deflate, br, zstd"],
      ["accept-language", acceptLanguage(discordLocale(locale()))],
    ])
    expect(request.headers.map(([name]) => name)).toEqual([...UPLOAD_HEADER_ORDER])
  })

  test("claim Linux when the client does", async () => {
    await harness.another({ os: "linux" }).upload(STORAGE_URL, BYTES, options())
    expect(harness.discord.requests[0]!.headers).toContainEqual(["sec-ch-ua-platform", '"Linux"'])
  })

  test("carry no token, no super properties and no API header", async () => {
    await harness.client.upload(STORAGE_URL, BYTES, options())
    const request = harness.discord.requests[0]!
    const names = request.headers.map(([name]) => name)
    for (const name of ["authorization", "x-super-properties", "x-discord-locale", "x-debug-options", "content-type"]) {
      expect(names).not.toContain(name)
    }
    expect(JSON.stringify([request.url, request.headers])).not.toContain(FAKE_TOKEN)
  })

  test("must name a plain referer, or nothing is sent", async () => {
    for (const referer of ["channels", "//evil.test", "/a\r\nx: y"]) {
      await expect(harness.client.upload(STORAGE_URL, BYTES, options({ referer }))).rejects.toMatchObject({
        code: "internal_error",
      })
    }
    expect(harness.discord.requests).toHaveLength(0)
    expect(harness.client.requests).toBe(0)
  })
})

describe("the token", () => {
  test("is never read: a client whose token source throws uploads, with no build number", async () => {
    const client = harness.another({ env: {} })
    await expect(client.read("GET", "/users/@me")).rejects.toBeDefined()
    expect(harness.discord.requests).toHaveLength(0)
    expect(await client.upload(STORAGE_URL, BYTES, options())).toEqual({ status: "uploaded" })
    expect(harness.discord.requests).toHaveLength(1)
    expect(client.requests).toBe(1)
  })
})

describe("pacing", () => {
  test("spaces uploads and API requests like any other, and counts them", async () => {
    await harness.warm()
    harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
    await harness.client.read("GET", "/users/@me")
    await harness.client.upload(STORAGE_URL, BYTES, options())
    await harness.client.upload(STORAGE_URL, BYTES, options())
    expect(harness.sleeps).toEqual([1100, 1100])
    expect(harness.sentAt.map((at) => at - harness.sentAt[0]!)).toEqual([0, 1100, 2200])
    expect(harness.client.requests).toBe(3)
  })

  test("stops at the request budget, before sending", async () => {
    const client = harness.another({ budget: 1 })
    await client.upload(STORAGE_URL, BYTES, options())
    await expect(client.upload(STORAGE_URL, BYTES, options())).rejects.toBeInstanceOf(BudgetSpent)
    expect(harness.discord.requests).toHaveLength(1)
    expect(client.requests).toBe(1)
  })
})

describe("a URL that is not Discord's storage", () => {
  const refused = [
    "http://b.storage.googleapis.com/abc/cat.png",
    "https://storage.googleapis.com/abc/cat.png",
    "https://evil.com/abc/cat.png",
    "https://x.storage.googleapis.com.evil.com/abc/cat.png",
    "https://evil.com/x.storage.googleapis.com/abc/cat.png",
    "https://user:pass@b.storage.googleapis.com/abc/cat.png",
    "https://user@b.storage.googleapis.com/abc/cat.png",
    "https://b.storage.googleapis.com:8443/abc/cat.png",
    "https://b.storage.googleapis.com./abc/cat.png",
    "https://cdn.discordapp.com/abc/cat.png",
    "not a url",
    "",
  ]

  test("is refused with no request", async () => {
    for (const url of refused) {
      expect(isStorageUrl(url)).toBe(false)
      expect(await harness.client.upload(url, BYTES, options())).toEqual({
        status: "refused",
        why: "not Discord's storage",
      })
    }
    expect(harness.discord.requests).toHaveLength(0)
    expect(harness.client.requests).toBe(0)
  })

  test("is told from a bucket host", () => {
    expect(isStorageUrl(STORAGE_URL)).toBe(true)
    expect(isStorageUrl("https://B.Storage.GoogleAPIs.com/x")).toBe(true)
  })
})

describe("a failed upload", () => {
  test("is any answer but 2xx, including a redirect that is not followed", async () => {
    for (const status of [403, 500, 302]) {
      harness.discord.route("PUT", STORAGE_PATH, { status, headers: { location: "https://evil.com/" } })
      expect(await harness.client.upload(STORAGE_URL, BYTES, options())).toEqual({
        status: "failed",
        why: `Discord's storage answered ${status}`,
        dispatched: true,
      })
    }
    expect(harness.discord.requests).toHaveLength(3)
  })

  test("is never retried", async () => {
    harness.discord.route("PUT", STORAGE_PATH, { status: 429, headers: { "retry-after": "1" } })
    await harness.client.upload(STORAGE_URL, BYTES, options())
    expect(harness.discord.requests).toHaveLength(1)
  })

  test("says whether a transport failure may have left, with text that holds no token", async () => {
    harness.discord.failNext({ dispatched: true, message: `reset by peer ${FAKE_TOKEN}` })
    const left = await harness.client.upload(STORAGE_URL, BYTES, options())
    expect(left).toMatchObject({ status: "failed", dispatched: true })
    expect(JSON.stringify(left)).not.toContain(FAKE_TOKEN)

    harness.discord.failNext({ dispatched: false, message: "connect refused" })
    expect(await harness.client.upload(STORAGE_URL, BYTES, options())).toEqual({
      status: "failed",
      why: "connect refused",
      dispatched: false,
    })
    expect(harness.discord.requests).toHaveLength(2)
  })
})

describe("cancellation", () => {
  test("before the call sends nothing", async () => {
    const signal = AbortSignal.abort()
    await expect(harness.client.upload(STORAGE_URL, BYTES, options({ signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(harness.discord.requests).toHaveLength(0)
    expect(harness.client.requests).toBe(0)
  })

  test("while the request is out rejects with the AbortError, not a failure", async () => {
    const controller = new AbortController()
    const client = harness.another({
      transport: async () => {
        controller.abort()
        throw new TransportFailure("cancelled", true)
      },
    })
    await expect(client.upload(STORAGE_URL, BYTES, options({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
  })

  test("during pacing sends nothing", async () => {
    await harness.warm()
    const controller = new AbortController()
    const client = harness.another({
      sleep: async (ms) => {
        harness.advance(ms)
        controller.abort()
      },
    })
    await client.upload(STORAGE_URL, BYTES, options())
    await expect(client.upload(STORAGE_URL, BYTES, options({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(harness.discord.requests).toHaveLength(1)
  })
})
