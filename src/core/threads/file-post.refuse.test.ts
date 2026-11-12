import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { CHANNEL } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { createFilePostFixture, type FilePostFixture } from "./file-post.testing"
import { BUG, STRANGER, STRICT_BARE_FORUM, STRICT_FORUM, TAGGED_FORUM } from "./post.testing"
import { ANNOUNCEMENT, CATEGORY, DM, FORUM, NAME, OLD_THREAD } from "./threads.testing"

let f: FilePostFixture

beforeEach(async () => {
  f = await createFilePostFixture()
  await f.files.write("work/a.txt", "hello")
})

afterEach(() => f.dispose())

/** Posts and expects a refusal with `code` before anything was requested, copied or staged. */
async function refused(args: Record<string, unknown>, code: ErrorCode, overrides = {}) {
  const error = await failure(f.postFiles({ channel: TAGGED_FORUM, name: NAME, files: ["a.txt"], ...args }, overrides))
  expect(error.code).toBe(code)
  expect(f.untouched()).toBe(true)
  expect(await f.staged()).toEqual([])
  return error
}

describe("arguments the tool refuses before anything is requested", () => {
  test.each([
    ["a channel that is a name", { channel: "ideas" }],
    ["an empty name", { name: "" }],
    ["a name over 100 characters", { name: "a".repeat(101) }],
    ["no files", { files: [] }],
    ["no files given at all", { files: undefined }],
    ["more than 10 files", { files: Array.from({ length: 11 }, (_, i) => `f${i}.txt`) }],
    ["a blank path", { files: [""] }],
    ["empty text", { text: "" }],
    ["whitespace-only text", { text: " \n " }],
    ["text over 4000 characters", { text: "x".repeat(4001) }],
    ["an empty tag list", { tags: [] }],
    ["a tag given twice", { tags: [BUG, BUG] }],
    ["an unknown argument", { type: 11 }],
  ])("%s is invalid_argument", async (_, extra) => {
    await refused(extra, "invalid_argument")
  })
})

describe("what the post refuses is refused before any file is looked at", () => {
  test.each([
    ["a text channel", { channel: CHANNEL }, "invalid_argument"],
    ["an announcement channel", { channel: ANNOUNCEMENT }, "invalid_argument"],
    ["a category", { channel: CATEGORY }, "invalid_argument"],
    ["a thread", { channel: OLD_THREAD }, "invalid_argument"],
    ["a DM", { channel: DM }, "invalid_argument"],
    ["a channel the mirror lacks", { channel: "1400000000000000999" }, "not_found"],
    ["a tag the forum does not list", { tags: [BUG, STRANGER] }, "invalid_argument"],
    ["tags of a forum whose tags the mirror lacks", { channel: FORUM, tags: [BUG] }, "not_found"],
    ["no tag in a forum that requires one", { channel: STRICT_FORUM }, "invalid_argument"],
    ["no tag in a forum that requires one and has none stored", { channel: STRICT_BARE_FORUM }, "invalid_argument"],
  ] as const)("%s, though the files would be refused too", async (_, extra, code) => {
    await refused({ ...extra, files: ["missing.txt"] }, code)
    await refused(extra, code)
    expect(existsSync(f.paths.outgoing)).toBe(false)
  })
})

describe("a file the send would refuse refuses the whole post", () => {
  test("a file outside send_dirs, by default the working directory", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    const error = await refused({ files: [outside] }, "invalid_argument")
    expect(error.details).toEqual({ file: outside })
  })

  test("a file outside an explicit send_dirs, though inside the working directory", async () => {
    await refused({ files: ["a.txt"] }, "invalid_argument", { sendDirs: [f.files.other] })
  })

  test("a link out of send_dirs, judged by its real path", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    await symlink(outside, join(f.files.work, "link.txt"))
    await refused({ files: ["link.txt"] }, "invalid_argument")
  })

  test.each([
    ["a .env file", ".env", "TOKEN=1"],
    ["a private key", "deploy.pem", "x"],
    ["a program", "setup.exe", "MZ"],
    ["a database", "app.sqlite", "x"],
    ["a file with a private key block", "notes.txt", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"],
  ])("%s", async (_, file, content) => {
    await f.files.write(`work/${file}`, content)
    await refused({ files: [file] }, "invalid_argument")
  })

  test("one refused file among good ones refuses all: nothing is copied, reserved or posted", async () => {
    await f.files.write("work/fine.txt", "fine")
    await f.files.write("work/.env", "TOKEN=1")
    await refused({ files: ["fine.txt", ".env"], text: "hi" }, "invalid_argument")
    expect(f.reservations()).toHaveLength(0)
    expect(f.posted()).toHaveLength(0)
  })

  test("a missing, an empty and a repeated file", async () => {
    await f.files.write("work/empty.txt", "")
    await refused({ files: ["missing.txt"] }, "invalid_argument")
    await refused({ files: ["empty.txt"] }, "invalid_argument")
    await refused({ files: ["a.txt", "./a.txt"] }, "invalid_argument")
  })

  test("a file over the cap that send_max_mb sets, and over the default cap when it is not set", async () => {
    await f.files.write("work/big.txt", "a".repeat(1024 * 1024 + 1))
    await refused({ files: ["big.txt"] }, "invalid_argument", { sendMaxMb: 1 })
    await f.files.write("work/ten.txt", "a".repeat(10 * 1024 * 1024 + 1))
    await refused({ files: ["ten.txt"] }, "invalid_argument")
  })
})
