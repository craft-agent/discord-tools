import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { failure } from "../chats/read.testing"
import type { MediaAnswer, MediaRequest } from "../discord/fake-media.testing"
import { CHANNEL, msgId } from "../discord/objects.testing"
import type { ToolContext } from "../tool"
import { attachment, attachmentUrl, createFilesFixture, namesIn, saveArgs, type FilesFixture } from "./files.testing"

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
  f.carry({ attachments: [attachment("cat.png")] })
  f.host(attachmentUrl("cat.png"), ["meow"])
})

afterEach(() => f.dispose())

/** A call that is refused before anything is sent to Discord or to its media host. */
async function refusedBeforeAnyRequest(call: Promise<unknown>, code: string, text?: string) {
  const error = await failure(call)
  expect(error).toMatchObject({ code, ...(text === undefined ? {} : { message: expect.stringContaining(text) }) })
  expect(f.discord.api).toEqual([])
  expect(f.media.requests).toEqual([])
  expect(await namesIn(f.folder)).toEqual([])
}

describe("what is refused before any request", () => {
  test("entries without unpack", async () => {
    await refusedBeforeAnyRequest(f.save(saveArgs({ entries: ["a"] })), "invalid_argument", "unpack")
    await refusedBeforeAnyRequest(f.save(saveArgs({ entries: ["a"], unpack: false })), "invalid_argument", "unpack")
  })

  test.each([
    ["an empty list of entries", { unpack: true, entries: [] }],
    ["an empty entry", { unpack: true, entries: [""] }],
    ["a name for an id", { channel: "general" }],
    ["an unknown argument", { super: true }],
  ])("%s", async (_, extra) => {
    await refusedBeforeAnyRequest(f.save(saveArgs(extra)), "invalid_argument")
  })

  test.each([
    ["no download directory", { downloadDir: undefined }],
    ["a relative download directory", { downloadDir: "downloads" }],
    ["no size limit", { downloadMaxMb: undefined }],
  ])("a call with %s is a bug of the entry point", async (_, override) => {
    await refusedBeforeAnyRequest(f.save(saveArgs(), { ...f.ctx, ...override }), "internal_error")
  })

  test.each([
    ["a message the mirror does not hold", { channel: CHANNEL, message: msgId(99) }],
    ["a channel the mirror does not know", { channel: "1400000000000000999", message: msgId(99) }],
  ])("%s", async (_, args) => {
    await refusedBeforeAnyRequest(f.save(args), "not_found")
  })

  test("a download directory that is the state directory, inside it or holding it, and leaves nothing behind", async () => {
    const before = await namesIn(f.stateDir)
    for (const downloadDir of [f.stateDir, join(f.stateDir, "downloads", "deeper"), dirname(f.stateDir)]) {
      await refusedBeforeAnyRequest(
        f.save(saveArgs(), { ...f.ctx, downloadDir }),
        "invalid_argument",
        "state directory",
      )
    }
    expect(await namesIn(f.stateDir)).toEqual(before)
  })

  test("a download directory that is the install directory, inside it or holding it", async () => {
    const holder = await f.tempDir("dsc-holder-")
    const own = join(holder, "own")
    await mkdir(own)
    for (const downloadDir of [own, join(own, "downloads"), holder]) {
      const ctx: ToolContext = { ...f.ctx, ownDir: own, downloadDir }
      await refusedBeforeAnyRequest(f.save(saveArgs(), ctx), "invalid_argument", "install directory")
    }
    expect(await namesIn(own)).toEqual([])
  })

  test("a download directory reached through a link into the state directory", async () => {
    await mkdir(f.downloadDir, { recursive: true })
    const linked = join(f.downloadDir, "link")
    await symlink(f.stateDir, linked)
    await refusedBeforeAnyRequest(
      f.save(saveArgs(), { ...f.ctx, downloadDir: linked }),
      "invalid_argument",
      "state directory",
    )
  })

  test("a download directory that cannot be made", async () => {
    await mkdir(f.downloadDir, { recursive: true })
    const file = join(f.downloadDir, "file")
    await writeFile(file, "x")
    await refusedBeforeAnyRequest(
      f.save(saveArgs(), { ...f.ctx, downloadDir: file }),
      "invalid_argument",
      "cannot be made",
    )
  })

  test("a link where the message's folder goes, before any download", async () => {
    const elsewhere = await f.tempDir("dsc-elsewhere-")
    await mkdir(f.downloadDir, { recursive: true })
    await symlink(elsewhere, f.folder)
    const error = await failure(f.save(saveArgs()))
    expect(error).toMatchObject({
      code: "invalid_argument",
      message: `${f.folder} is not a plain folder (a link or a file); nothing was saved.`,
    })
    expect(f.media.requests).toEqual([])
    expect(await namesIn(elsewhere)).toEqual([])
  })

  test("a file where the message's folder goes", async () => {
    await mkdir(f.downloadDir, { recursive: true })
    await writeFile(f.folder, "x")
    expect(await failure(f.save(saveArgs()))).toMatchObject({ code: "invalid_argument" })
    expect(f.media.requests).toEqual([])
    expect(await readFile(f.folder, "utf8")).toBe("x")
  })

  test("a folder that is there already is used", async () => {
    await mkdir(f.folder, { recursive: true, mode: 0o700 })
    expect((await f.save(saveArgs())).files[0]).toMatchObject({ status: "saved" })
  })
})

describe("what the fresh read finds", () => {
  test("a message Discord no longer shows is not_found, and nothing is downloaded or written", async () => {
    f.carry({ attachments: [attachment("cat.png")] })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: [] })
    expect(await failure(f.save(saveArgs()))).toMatchObject({ code: "not_found" })
    expect(f.media.requests).toEqual([])
    expect(await namesIn(f.folder)).toEqual([])
  })

  test("a message that carries nothing is refused without a download", async () => {
    f.carry({ content: "just words", embeds: [{ url: "https://example.com", title: "t" }] })
    const error = await failure(f.save(saveArgs()))
    expect(error).toMatchObject({
      code: "invalid_argument",
      message: `Message ${saveArgs().message} carries no attachments, link previews or stickers.`,
    })
    expect(f.media.requests).toEqual([])
    expect(await namesIn(f.folder)).toEqual([])
  })

  test("the page is stored in the mirror like any live read", async () => {
    f.carry({ attachments: [attachment("cat.png")] })
    f.seed((m) => m.prepare("UPDATE messages SET content = 'old' WHERE id = ?").run(BigInt(saveArgs().message)))
    await f.save(saveArgs())
    const content = f.inspect(
      (m) =>
        (m.prepare("SELECT content FROM messages WHERE id = ?").get(BigInt(saveArgs().message)) as { content: string })
          .content,
    )
    expect(content).not.toBe("old")
  })
})

describe("the staging folder", () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  test("is empty after a call, whatever became of its files", async () => {
    f.carry({ attachments: [attachment("cat.png"), attachment("setup.exe"), attachment("gone.png")] })
    await f.save(saveArgs())
    expect(await f.staged()).toEqual([])
  })

  test("is empty after a call that fails", async () => {
    f.media.answer = () => {
      throw new Error("the host broke")
    }
    await f.save(saveArgs()).catch(() => {})
    expect(await f.staged()).toEqual([])
  })

  test("loses what an earlier call left there more than 24 hours ago, and keeps newer leftovers", async () => {
    const old = join(f.paths.incoming, "0".repeat(16))
    const recent = join(f.paths.incoming, "1".repeat(16))
    for (const dir of [old, recent]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "01"), "x")
    }
    const stamp = (dir: string, age: number) => utimes(dir, new Date(f.now() - age), new Date(f.now() - age))
    await stamp(old, DAY_MS + 60_000)
    await stamp(recent, DAY_MS - 60_000)
    await f.save(saveArgs())
    expect(await f.staged()).toEqual(["1".repeat(16)])
  })
})

describe("the time of a call", () => {
  /** Makes each download take `ms` of the call's time, by the fake clock. */
  function takeTime(ms: number): MediaRequest[] {
    const inner = f.media.answer as (request: MediaRequest) => MediaAnswer
    f.media.answer = (request) => {
      f.advance(ms)
      return inner(request)
    }
    return f.media.requests
  }

  test("each download gets what is left of the 540 seconds when that is under 180", async () => {
    f.carry({ attachments: [attachment("a.png"), attachment("b.png")] })
    f.host(attachmentUrl("a.png"), ["a"])
    f.host(attachmentUrl("b.png"), ["b"])
    const requests = takeTime(450_000)
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => file.status)).toEqual(["saved", "saved"])
    expect(requests[0]!.timeoutMs).toBe(180_000)
    expect(requests[1]!.timeoutMs).toBeGreaterThan(80_000)
    expect(requests[1]!.timeoutMs).toBeLessThan(90_000)
  })

  test("with under 5 seconds left, a file fails as out of time without a request", async () => {
    f.carry({ attachments: [attachment("a.png"), attachment("b.png"), attachment("c.png")] })
    f.host(attachmentUrl("a.png"), ["a"])
    const requests = takeTime(538_000)
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => [file.status, file.why])).toEqual([
      ["saved", undefined],
      ["failed", "out of time for this call"],
      ["failed", "out of time for this call"],
    ])
    expect(requests).toHaveLength(1)
    expect(result.folder).toBe(f.folder)
  })
})
