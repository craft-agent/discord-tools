import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMediaUrl } from "./client"
import { type Harness, FAKE_TOKEN, createHarness } from "./client.testing"
import { FakeMedia } from "./fake-media.testing"

const MEDIA_URL = "https://cdn.discordapp.com/attachments/1/2/cat.png"
const MAX_BYTES = 10
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

async function filesLeft(): Promise<string[]> {
  return readdir(dir)
}

describe("the hosts", () => {
  const allowed = [
    MEDIA_URL,
    "https://media.discordapp.net/attachments/1/2/cat.png",
    "https://images-ext-2.discordapp.net/external/abc/https/example.test/x.png",
    "https://images-ext-12345.discordapp.net/x",
    "https://CDN.DISCORDAPP.COM/x",
    "https://cdn.discordapp.com:443/x",
  ]
  const refused = [
    "http://cdn.discordapp.com/x",
    "https://discord.com/x",
    "https://discordapp.com/x",
    "https://cdn.discordapp.com.evil.com/x",
    "https://evil.com/cdn.discordapp.com",
    "https://evil.com/?https://cdn.discordapp.com/",
    "https://user@cdn.discordapp.com/x",
    "https://user:pass@cdn.discordapp.com/x",
    "https://cdn.discordapp.com:8443/x",
    "https://images-ext-x.discordapp.net/x",
    "https://images-ext-.discordapp.net/x",
    "https://images-ext-2.discordapp.net.evil.com/x",
    "https://sub.cdn.discordapp.com/x",
    "https://cdn.discordapp.com./x",
    "ftp://cdn.discordapp.com/x",
    "cdn.discordapp.com/x",
    "",
  ]

  test("are Discord's CDN and media proxy only", () => {
    for (const url of allowed) expect(isMediaUrl(url)).toBe(true)
    for (const url of refused) expect(isMediaUrl(url)).toBe(false)
  })

  test("a refused URL is refused without a request or a file", async () => {
    for (const url of refused) {
      expect(await harness.client.download(url, options())).toEqual({
        status: "refused",
        why: "not on Discord's media hosts",
      })
    }
    expect(media.requests).toHaveLength(0)
    expect(harness.client.requests).toBe(0)
    expect(await filesLeft()).toEqual([])
  })

  test("a backslash is a path separator, as the transport reads it, so no other host hides behind it", async () => {
    await harness.client.download("https://cdn.discordapp.com\\@evil.com/x", options())
    expect(media.requests.map((request) => request.url)).toEqual(["https://cdn.discordapp.com/@evil.com/x"])
  })

  test("an allowed one is asked for", async () => {
    for (const url of allowed) {
      await harness.client.download(url, options())
      await rm(to)
    }
    expect(media.requests).toHaveLength(allowed.length)
  })
})

describe("an answer that is not a file", () => {
  test.each([302, 301, 404, 403, 429, 500])("%d is missing, with its code, and leaves no file", async (status) => {
    media.answer = { status, headers: { location: "https://evil.test/" }, chunks: ["body"] }
    expect(await harness.client.download(MEDIA_URL, options())).toEqual({
      status: "missing",
      why: `Discord's media host answered ${status}`,
    })
    expect(media.requests).toHaveLength(1)
    expect(media.cancelled).toBe(1)
    expect(media.chunksRead).toBe(0)
    expect(await filesLeft()).toEqual([])
  })

  test("is never retried", async () => {
    media.answer = { status: 429 }
    await harness.client.download(MEDIA_URL, options())
    expect(media.requests).toHaveLength(1)
    expect(harness.sleeps).toEqual([])
  })
})

describe("a file that is too large", () => {
  test("by its declared size, without a request or a file", async () => {
    const result = await harness.client.download(MEDIA_URL, options({ declaredSize: MAX_BYTES + 1 }))
    expect(result).toEqual({ status: "too_large" })
    expect(media.requests).toHaveLength(0)
    expect(harness.client.requests).toBe(0)
    expect(await filesLeft()).toEqual([])
  })

  test("a declared size within the limit is no reason to refuse", async () => {
    media.answer = { chunks: ["abc"] }
    expect(await harness.client.download(MEDIA_URL, options({ declaredSize: MAX_BYTES }))).toMatchObject({
      status: "saved",
    })
  })

  test("by content-length, without reading the body", async () => {
    media.answer = { headers: { "content-length": String(MAX_BYTES + 1) }, chunks: ["a", "b"] }
    expect(await harness.client.download(MEDIA_URL, options())).toEqual({ status: "too_large" })
    expect(media.chunksRead).toBe(0)
    expect(media.cancelled).toBe(1)
    expect(await filesLeft()).toEqual([])
  })

  test("by the bytes streamed, which stop being read and leave no file", async () => {
    media.answer = { chunks: ["0123456", "78901", "never", "read"] }
    expect(await harness.client.download(MEDIA_URL, options())).toEqual({ status: "too_large" })
    expect(media.chunksRead).toBe(2)
    expect(media.cancelled).toBe(1)
    expect(await filesLeft()).toEqual([])
  })
})

describe("a failure", () => {
  test("below HTTP is failed, with its text masked, and leaves no file", async () => {
    media.failNext(`connection reset for ${FAKE_TOKEN} and mfa.${"a".repeat(30)}`)
    const result = await harness.client.download(MEDIA_URL, options())
    expect(result).toMatchObject({ status: "failed" })
    const why = (result as { why: string }).why
    expect(why).toContain("<token>")
    expect(why).not.toContain(FAKE_TOKEN)
    expect(why).not.toContain("mfa.")
    expect(await filesLeft()).toEqual([])
    expect(media.requests).toHaveLength(1)
  })

  test("while the body is read is failed, and removes the partial file", async () => {
    media.answer = { chunks: ["abc"], after: { fail: "connection reset" } }
    expect(await harness.client.download(MEDIA_URL, options())).toEqual({
      status: "failed",
      why: "Could not download the file: connection reset",
    })
    expect(media.cancelled).toBe(1)
    expect(await filesLeft()).toEqual([])
  })

  test("of a body that outlasts the time limit is failed, and removes the partial file", async () => {
    media.answer = { chunks: ["abc"], after: "hang" }
    const result = await harness.client.download(MEDIA_URL, options({ timeoutMs: 30 }))
    expect(result).toEqual({ status: "failed", why: "The download took longer than 0.03 seconds." })
    expect(await filesLeft()).toEqual([])
  })
})

describe("cancellation", () => {
  test("before the call sends nothing and creates nothing", async () => {
    await expect(harness.client.download(MEDIA_URL, options({ signal: AbortSignal.abort() }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(media.requests).toHaveLength(0)
    expect(await filesLeft()).toEqual([])
  })

  test("during the body rejects with the AbortError and removes the partial file", async () => {
    media.answer = { chunks: ["abc"], after: "hang" }
    const controller = new AbortController()
    const download = harness.client.download(MEDIA_URL, options({ signal: controller.signal }))
    await media.hanging.promise
    expect(await filesLeft()).toEqual(["cat.png"])
    controller.abort()
    await expect(download).rejects.toMatchObject({ name: "AbortError" })
    expect(media.cancelled).toBe(1)
    expect(await filesLeft()).toEqual([])
  })

  test("during pacing sends nothing and removes the file it made", async () => {
    await harness.client.download(MEDIA_URL, options({ to: join(dir, "first.png") }))
    const controller = new AbortController()
    const client = harness.another({
      sleep: async () => {
        controller.abort()
      },
    })
    await expect(client.download(MEDIA_URL, options({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(media.requests).toHaveLength(1)
    expect(client.requests).toBe(0)
    expect(await filesLeft()).toEqual(["first.png"])
  })
})

describe("the file", () => {
  test("is never overwritten: an existing one is failed, before any request", async () => {
    await writeFile(to, "mine")
    const result = await harness.client.download(MEDIA_URL, options())
    expect(result).toMatchObject({ status: "failed" })
    expect((result as { why: string }).why).toStartWith("Could not create the file: ")
    expect(media.requests).toHaveLength(0)
    expect((await readFile(to)).toString()).toBe("mine")
  })

  test("is never reached through a link, a dangling one included", async () => {
    const target = join(dir, "target")
    await writeFile(target, "mine")
    for (const link of ["live", "dangling"]) {
      await symlink(link === "live" ? target : join(dir, "nowhere"), join(dir, link))
      const result = await harness.client.download(MEDIA_URL, options({ to: join(dir, link) }))
      expect(result).toMatchObject({ status: "failed" })
    }
    expect(media.requests).toHaveLength(0)
    expect((await readFile(target)).toString()).toBe("mine")
    expect((await filesLeft()).sort()).toEqual(["dangling", "live", "target"])
  })

  test("needs its directory: a missing one is failed", async () => {
    const result = await harness.client.download(MEDIA_URL, options({ to: join(dir, "missing", "cat.png") }))
    expect(result).toMatchObject({ status: "failed" })
    expect(media.requests).toHaveLength(0)
  })
})
