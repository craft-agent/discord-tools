import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BudgetSpent } from "./client"
import { type Harness, createHarness } from "./client.testing"
import { FakeMedia } from "./fake-media.testing"
import { acceptLanguage, clientHints, discordLocale, locale, userAgent } from "./identity"
import { MEDIA_HEADER_ORDER } from "./request-headers"

const URL_OF_CAT = "https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1&is=2&hm=3"
const MAX_BYTES = 1000
const TIMEOUT_MS = 180_000

let harness: Harness
let media: FakeMedia
let dir: string
let to: string

beforeEach(async () => {
  media = new FakeMedia(() => harness.now())
  harness = await createHarness({ download: media.transport })
  dir = await mkdtemp(join(tmpdir(), "dsc-media-"))
  to = join(dir, "cat.png")
})

afterEach(async () => {
  await harness.dispose()
  await rm(dir, { recursive: true, force: true })
})

function options(extra: Partial<Parameters<Harness["client"]["download"]>[1]> = {}) {
  return { to, maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, ...extra }
}

describe("a saved download", () => {
  test("writes the body to the file with mode 0600 and reports its size and type", async () => {
    media.answer = {
      headers: { "content-type": "Image/PNG; charset=binary", "content-length": "11" },
      chunks: ["hello ", "world"],
    }
    const result = await harness.client.download(URL_OF_CAT, options())
    expect(result).toEqual({ status: "saved", size: 11, type: "image/png" })
    expect((await readFile(to)).toString()).toBe("hello world")
    expect((await stat(to)).mode & 0o777).toBe(0o600)
    expect(media.cancelled).toBe(1)
  })

  test("leaves the type out when the answer names none", async () => {
    media.answer = { chunks: ["x"] }
    expect(await harness.client.download(URL_OF_CAT, options())).toEqual({ status: "saved", size: 1 })
  })

  test("saves an empty body, and a body of exactly maxBytes", async () => {
    expect(await harness.client.download(URL_OF_CAT, options())).toEqual({ status: "saved", size: 0 })
    await rm(to)
    media.answer = { chunks: ["a".repeat(MAX_BYTES)] }
    expect(await harness.client.download(URL_OF_CAT, options())).toEqual({ status: "saved", size: MAX_BYTES })
  })

  test("asks for the URL once, with GET and the time limit", async () => {
    await harness.client.download(URL_OF_CAT, options({ timeoutMs: 5000 }))
    expect(media.requests).toHaveLength(1)
    expect(media.requests[0]).toMatchObject({ method: "GET", url: URL_OF_CAT, timeoutMs: 5000 })
  })

  test("is sent as the URL the check parsed", async () => {
    await harness.client.download("https://CDN.discordapp.com:443/a/../b.png#frag", options())
    expect(media.requests[0]!.url).toBe("https://cdn.discordapp.com/b.png#frag")
  })
})

describe("the headers", () => {
  test("are Chrome's for a cross-site image fetch, in order", async () => {
    await harness.client.download(URL_OF_CAT, options())
    const hints = clientHints("macos")
    expect(media.requests[0]!.headers).toEqual([
      ["sec-ch-ua", hints.ua],
      ["sec-ch-ua-mobile", hints.mobile],
      ["sec-ch-ua-platform", hints.platform],
      ["user-agent", userAgent("macos")],
      ["accept", "*/*"],
      ["sec-fetch-site", "cross-site"],
      ["sec-fetch-mode", "no-cors"],
      ["sec-fetch-dest", "image"],
      ["referer", "https://discord.com/"],
      ["accept-encoding", "gzip, deflate, br, zstd"],
      ["accept-language", acceptLanguage(discordLocale(locale()))],
    ])
    expect(media.requests[0]!.headers.map(([name]) => name)).toEqual([...MEDIA_HEADER_ORDER])
  })

  test("claim Linux when the client does", async () => {
    await harness.another({ os: "linux" }).download(URL_OF_CAT, options())
    expect(media.requests[0]!.headers).toContainEqual(["sec-ch-ua-platform", '"Linux"'])
  })

  test("carry no token, no super properties and no API header", async () => {
    await harness.client.download(URL_OF_CAT, options())
    const names = media.requests[0]!.headers.map(([name]) => name)
    for (const name of ["authorization", "x-super-properties", "x-discord-locale", "x-debug-options", "origin"]) {
      expect(names).not.toContain(name)
    }
  })
})

describe("the token", () => {
  test("is never read: a client with no token downloads, and asks for no build number", async () => {
    const client = harness.another({ env: {} })
    await expect(client.read("GET", "/users/@me")).rejects.toBeDefined()
    expect(harness.discord.requests).toHaveLength(0)
    expect(await client.download(URL_OF_CAT, options())).toMatchObject({ status: "saved" })
    expect(harness.discord.requests).toHaveLength(0)
    expect(client.requests).toBe(1)
  })
})

describe("pacing", () => {
  test("spaces downloads and API requests like any other, and counts them", async () => {
    await harness.warm()
    harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
    await harness.client.read("GET", "/users/@me")
    await harness.client.download(URL_OF_CAT, options())
    await rm(to)
    await harness.client.download(URL_OF_CAT, options())
    expect(harness.sleeps).toEqual([1100, 1100])
    expect(media.requests.map((request) => request.at - harness.sentAt[0]!)).toEqual([1100, 2200])
    expect(harness.client.requests).toBe(3)
  })

  test("stops at the request budget, before sending and without a file", async () => {
    const client = harness.another({ budget: 1 })
    await client.download(URL_OF_CAT, options())
    await rm(to)
    await expect(client.download(URL_OF_CAT, options())).rejects.toBeInstanceOf(BudgetSpent)
    expect(media.requests).toHaveLength(1)
    expect(client.requests).toBe(1)
    expect(await readdir(dir)).toEqual([])
  })

  test("serves concurrent downloads one after another", async () => {
    const second = join(dir, "second.png")
    await Promise.all([
      harness.client.download(URL_OF_CAT, options()),
      harness.client.download(URL_OF_CAT, options({ to: second })),
    ])
    expect(media.requests.map((request, i) => request.at - (media.requests[i - 1]?.at ?? request.at))).toEqual([
      0, 1100,
    ])
  })
})
