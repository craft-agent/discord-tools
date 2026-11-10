import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { CHANNEL, msgId } from "../discord/objects.testing"
import { answerFileSends, createFileSendFixture, type FileSendFixture } from "./file-send.testing"

let f: FileSendFixture

beforeEach(async () => {
  f = await createFileSendFixture()
  answerFileSends(f)
})

afterEach(() => f.dispose())

/** Sends and expects a refusal with `code` before anything was requested, recorded or copied. */
async function refused(args: Record<string, unknown>, code: string, overrides = {}) {
  const error = await failure(f.sendFiles({ channel: CHANNEL, ...args }, overrides))
  expect(error).toMatchObject({ code })
  expect(f.untouched()).toBe(true)
  expect(f.ledger()).toEqual([])
  expect(await f.staged()).toEqual([])
  return error
}

describe("a file send that is refused before anything leaves", () => {
  test("a file outside send_dirs, by default the working directory", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    const error = await refused({ files: [outside] }, "invalid_argument")
    expect(error.details).toEqual({ file: outside })
  })

  test("a file outside an explicit send_dirs, though inside the working directory", async () => {
    await f.files.write("work/a.txt", "inside")
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
  ])("%s", async (_name, file, content) => {
    await f.files.write(`work/${file}`, content)
    await refused({ files: [file] }, "invalid_argument")
  })

  test("a file with a private key block", async () => {
    await f.files.write("work/notes.txt", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n")
    await refused({ files: ["notes.txt"] }, "invalid_argument")
  })

  test("one refused file refuses the whole send", async () => {
    await f.files.write("work/fine.txt", "fine")
    await f.files.write("work/.env", "TOKEN=1")
    await refused({ files: ["fine.txt", ".env"], text: "hi" }, "invalid_argument")
  })

  test("a missing, an empty and a repeated file", async () => {
    await f.files.write("work/empty.txt", "")
    await f.files.write("work/a.txt", "a")
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

  test("an unknown chat is not_found, before any file is looked at", async () => {
    const error = await failure(f.sendFiles({ channel: "1400000000000000999", files: ["missing.txt"] }))
    expect(error).toMatchObject({ code: "not_found" })
    expect(f.untouched()).toBe(true)
    expect(f.ledger()).toEqual([])
  })

  test("an unknown reply is not_found and names the way to find one", async () => {
    await f.files.write("work/a.txt", "a")
    const error = await refused({ files: ["a.txt"], reply_to: msgId(99) }, "not_found")
    expect(error.message).toContain("discord_chat_read")
  })

  test.each([
    ["no files", { files: [] }],
    ["more than 10 files", { files: Array.from({ length: 11 }, (_, i) => `f${i}.txt`) }],
    ["a blank path", { files: [""] }],
    ["whitespace-only text", { files: ["a.txt"], text: " \n " }],
    ["empty text", { files: ["a.txt"], text: "" }],
    ["text over 4000 characters", { files: ["a.txt"], text: "x".repeat(4001) }],
    ["an unknown argument", { files: ["a.txt"], tts: true }],
  ])("%s is invalid_argument", async (_name, args) => {
    await refused(args, "invalid_argument")
  })
})
