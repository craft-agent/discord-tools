import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { FORUM } from "../chats/read.messages.testing"
import { namesIn } from "../files/files.testing"
import { CHANNEL, msgId } from "../discord/objects.testing"
import { said, store } from "../search/search.testing"
import { createExportFixture, type ExportFixture } from "./export-tool.testing"
import { vouch } from "./export.testing"

let f: ExportFixture
beforeEach(async () => {
  f = await createExportFixture()
})
afterEach(async () => {
  await f.dispose()
})

/** Whether the download directory holds nothing at all: no file, no folder. */
const leftNothing = async () => expect(await namesIn(f.downloadDir)).toEqual([])

describe("the arguments", () => {
  test.each([
    ["a name for a chat id", { chat: "general" }],
    ["an unknown argument", { format: "markdown", pages: 2 }],
    ["a format that is none", { format: "html" }],
    ["a limit of 0", { limit: 0 }],
    ["a limit over the maximum", { limit: 10001 }],
    ["a bound in no accepted form", { after: "yesterday" }],
    ["a date that does not exist", { before: "2026-02-30" }],
    ["an after that is not earlier than before", { after: msgId(5), before: msgId(5) }],
    ["a time zone that is not an IANA name", { time_zone: "Nowhere/Land" }],
  ])("%s is invalid_argument, and nothing is written", async (_what, extra) => {
    f.seedTen()
    expect(await failure(f.exportChat(extra))).toMatchObject({ code: "invalid_argument" })
    await leftNothing()
  })

  test("a limit over the maximum names the maximum", async () => {
    expect((await failure(f.exportChat({ limit: 10001 }))).message).toContain("at most 10000")
  })

  test("the arguments are checked before the label is opened", async () => {
    const error = await failure(f.exportChat({ account: "nobody", limit: 10001 }))
    expect(error).toMatchObject({ code: "invalid_argument" })
  })
})

describe("what cannot be exported", () => {
  test("a chat the mirror does not know is not_found", async () => {
    expect(await failure(f.exportChat({ chat: "1400000000000000999" }))).toMatchObject({ code: "not_found" })
    await leftNothing()
  })

  test("a chat with messages but nothing vouched is not_found", async () => {
    store(f, said(CHANNEL, 1), said(CHANNEL, 2))
    expect(await failure(f.exportChat())).toMatchObject({ code: "not_found" })
    await leftNothing()
  })

  test("a forum is invalid_argument", async () => {
    expect(await failure(f.exportChat({ chat: FORUM }))).toMatchObject({ code: "invalid_argument" })
    await leftNothing()
  })

  test("a range with no mirrored message is invalid_argument", async () => {
    f.seedTen()
    expect(await failure(f.exportChat({ after: msgId(10) }))).toMatchObject({ code: "invalid_argument" })
    expect(await failure(f.exportChat({ before: msgId(1) }))).toMatchObject({ code: "invalid_argument" })
    await leftNothing()
  })

  test("a download directory that is, or holds, the state directory is refused, and nothing is made", async () => {
    vouch(f, CHANNEL, 1, 1)
    store(f, said(CHANNEL, 1))
    for (const downloadDir of [f.stateDir, join(f.stateDir, "downloads")]) {
      const error = await failure(f.exportChat({}, { ...f.ctx, downloadDir, downloadMaxMb: 1 }))
      expect(error).toMatchObject({ code: "invalid_argument" })
    }
    expect(await namesIn(join(f.stateDir, "downloads"))).toEqual([])
    await leftNothing()
  })

  test("a call without a download directory is an internal_error", async () => {
    f.seedTen()
    const { downloadDir: _dir, downloadMaxMb: _max, ...bare } = f.ctx
    expect(await failure(f.exportChat({}, bare))).toMatchObject({ code: "internal_error" })
  })
})
