import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { idTime } from "../chats/format"
import { failure } from "../chats/read.testing"
import { slotOf } from "../sends/upload.testing"
import { attachPath, createFilePostFixture, type FilePostFixture } from "./file-post.testing"
import { discordFilePost } from "./file-post-tool"
import { NEW_POST, postObject, postPath, postSearchPath, TAGGED_FORUM } from "./post.testing"
import { NAME } from "./threads.testing"

let f: FilePostFixture

beforeEach(async () => {
  f = await createFilePostFixture()
  await f.files.write("work/a.txt", "first")
  await f.files.write("work/b.txt", "second")
})

afterEach(() => f.dispose())

const ARGS = { channel: TAGGED_FORUM, name: NAME, files: ["a.txt", "b.txt"], text: "hi" }
const post = (extra: Record<string, unknown> = {}) => failure(f.postFiles({ ...ARGS, ...extra }))

/** Expects that nothing was posted, nothing was looked up afterwards, and no copy is left. */
async function expectNotPosted() {
  expect(f.posted()).toEqual([])
  expect(f.reads()).toEqual([])
  expect(await f.staged()).toEqual([])
  expect(f.row(NEW_POST)).toBeUndefined()
}

describe("a post whose upload fails", () => {
  test.each([
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ])("a reservation that Discord answers with %i is %s, and nothing is uploaded or posted", async (status, code) => {
    f.discord.route("POST", attachPath(), { status, json: { message: "no", retry_after: 1.5 } })
    expect(await post()).toMatchObject({ code })
    expect(f.reservations()).toHaveLength(1)
    expect(f.puts()).toHaveLength(0)
    await expectNotPosted()
  })

  test("a reservation that fails after it left is upstream_error, not uncertain", async () => {
    f.discord.route("POST", attachPath(), { status: 500, json: {} })
    expect(await post()).toMatchObject({ code: "upstream_error", message: expect.stringContaining("no message") })
    expect(f.puts()).toHaveLength(0)
    await expectNotPosted()
  })

  test("a reservation without usable slots is upstream_error", async () => {
    f.discord.route("POST", attachPath(), { status: 200, json: { attachments: [] } })
    expect(await post()).toMatchObject({ code: "upstream_error" })
    expect(f.puts()).toHaveLength(0)
    await expectNotPosted()
  })

  test("an upload that fails stops the rest, posts nothing and is never retried", async () => {
    f.discord.route("PUT", "/up/0/file.bin", { status: 500 })
    expect(await post()).toMatchObject({ code: "upstream_error", message: expect.stringContaining("no message") })
    expect(f.puts()).toHaveLength(1)
    await expectNotPosted()
  })

  test("a later upload that fails leaves the earlier one unused", async () => {
    f.discord.route("PUT", "/up/1/file.bin", { status: 500 })
    expect(await post()).toMatchObject({ code: "upstream_error" })
    expect(f.puts()).toHaveLength(2)
    await expectNotPosted()
  })

  test("a copy changed after it was checked is stale: nothing is uploaded or posted", async () => {
    f.discord.route("POST", attachPath(), () => {
      const [dir] = readdirSync(f.paths.outgoing)
      const copy = join(f.paths.outgoing, dir!, "02")
      writeFileSync(copy, "x".repeat(readFileSync(copy).length))
      return { status: 200, json: { attachments: [slotOf(0), slotOf(1)] } }
    })
    expect(await post()).toMatchObject({ code: "stale" })
    expect(f.puts()).toHaveLength(1)
    await expectNotPosted()
  })

  test("a call cancelled between uploads posts nothing", async () => {
    const controller = new AbortController()
    f.discord.route("PUT", "/up/0/file.bin", () => {
      controller.abort()
      return { status: 200 }
    })
    const error = await discordFilePost.execute(ARGS, { ...f.ctx, signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ name: "AbortError" })
    expect(f.puts()).toHaveLength(1)
    await expectNotPosted()
  })
})

describe("a post that Discord refuses once the files are up", () => {
  test("is thrown as it is, never retried, with no read-back and no copy left", async () => {
    f.discord.route("POST", postPath(), { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    expect(await post()).toMatchObject({ code: "forbidden" })
    expect(f.puts()).toHaveLength(2)
    expect(f.posted()).toHaveLength(1)
    expect(f.reads()).toEqual([])
    expect(await f.staged()).toEqual([])
  })
})

describe("a post whose outcome is unknown after the files are up", () => {
  const serveSearch = (threads: unknown[]) =>
    f.discord.route("GET", postSearchPath(), { status: 200, json: { threads, first_messages: [], has_more: false } })

  test.each([
    ["a server error", () => f.discord.route("POST", postPath(), { status: 500, json: { message: "oops" } })],
    ["an answer that is not JSON", () => f.discord.route("POST", postPath(), { status: 200, text: "<html>" })],
    ["an answer without a thread", () => f.discord.route("POST", postPath(), { status: 200, json: {} })],
    [
      "a request dropped after it left",
      () =>
        f.discord.route("PUT", "/up/1/file.bin", () => {
          f.discord.failNext({ dispatched: true, message: "timed out" })
          return { status: 200 }
        }),
    ],
  ])("%s is uncertain, never retried, never stored, read back once, and leaves no copy", async (_, serve) => {
    serve()
    serveSearch([])
    expect(await post()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { read_back: { found: [] } },
    })
    expect(f.reservations()).toHaveLength(1)
    expect(f.puts()).toHaveLength(2)
    expect(f.posted()).toHaveLength(1)
    expect(f.reads()).toHaveLength(1)
    expect(f.row(NEW_POST)).toBeUndefined()
    expect(await f.staged()).toEqual([])
  })

  test("the read-back lists the account's posts of that name in the forum", async () => {
    f.discord.route("POST", postPath(), { status: 502, json: {} })
    serveSearch([postObject(NEW_POST)])
    expect(await post()).toMatchObject({
      details: { read_back: { found: [{ id: NEW_POST, name: NAME, created_at: idTime(NEW_POST) }] } },
    })
    expect(f.reads()[0]!.path).toBe(postSearchPath())
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("POST", postPath(), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordFilePost.execute(ARGS, { ...f.ctx, signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toHaveLength(0)
    expect(await f.staged()).toEqual([])
  })
})
