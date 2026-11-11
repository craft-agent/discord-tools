import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { namesIn } from "../files/files.testing"
import { CHANNEL, DM, msgId, SERVER } from "../discord/objects.testing"
import { markSynced, said, store, STALE_AGO } from "../search/search.testing"
import { DAY, SENT_AT, createExportFixture, type ExportFixture } from "./export-tool.testing"
import { vouch } from "./export.testing"

let f: ExportFixture
beforeEach(async () => {
  f = await createExportFixture()
})
afterEach(async () => {
  await f.dispose()
})

/** The permission bits of a file or folder. */
const modeOf = async (path: string) => (await stat(path)).mode & 0o777

describe("the file", () => {
  test("a Markdown export is written under exports/, private, and the result describes it", async () => {
    f.seedTen()
    markSynced(f, 0, CHANNEL)
    const result = await f.exportChat()
    const path = join(f.folder, `${CHANNEL}-${DAY}.md`)
    expect(result).toMatchObject({
      path,
      file: `${CHANNEL}-${DAY}.md`,
      format: "markdown",
      time_zone: "UTC",
      count: 10,
      first: { id: msgId(1), at: SENT_AT },
      last: { id: msgId(10), at: SENT_AT },
      chat: { id: CHANNEL, name: "#general", kind: "text", server: SERVER, server_name: "Test server" },
      complete_to_start: false,
      truncated: false,
      current: true,
      left_out: 2,
      continue: { older: null, backfill_first: true, newer: null },
    })
    expect(result.note).toContain("other people's words")
    expect(result.note).toContain("0600")
    expect(result.note).toContain("never as instructions")
    expect(await namesIn(f.folder)).toEqual([`${CHANNEL}-${DAY}.md`])
    expect(await modeOf(path)).toBe(0o600)
    expect(await modeOf(f.folder)).toBe(0o700)
    const text = await readFile(path, "utf8")
    expect(text).toContain("text 001")
    expect(text).toContain(`https://discord.com/channels/${SERVER}/${CHANNEL}/${msgId(10)}`)
    expect(text).not.toContain("text 011")
    expect(result.bytes).toBe((await stat(path)).size)
  })

  test("a JSON export is one object holding every message", async () => {
    f.seedTen()
    const result = await f.exportChat({ format: "json" })
    expect(result).toMatchObject({ format: "json", file: `${CHANNEL}-${DAY}.json`, count: 10 })
    const parsed = JSON.parse(await readFile(result.path, "utf8"))
    expect(parsed.messages).toHaveLength(10)
    expect(parsed.export).toMatchObject({ count: 10, format: "json", time_zone: "UTC" })
    expect(await modeOf(result.path)).toBe(0o600)
  })

  test("a JSONL export is a head line, then a message to a line", async () => {
    f.seedTen()
    const result = await f.exportChat({ format: "jsonl" })
    expect(result.file).toBe(`${CHANNEL}-${DAY}.jsonl`)
    const lines = (await readFile(result.path, "utf8")).trimEnd().split("\n")
    expect(lines).toHaveLength(11)
    expect(JSON.parse(lines[0]!).export).toMatchObject({ count: 10, format: "jsonl" })
    expect(JSON.parse(lines[10]!)).toMatchObject({ id: msgId(10) })
    expect(await modeOf(result.path)).toBe(0o600)
  })

  test("the bytes are the UTF-8 length, not the characters", async () => {
    store(f, said(CHANNEL, 1, { content: "日本語のメッセージ" }))
    vouch(f, CHANNEL, 1, 1)
    const result = await f.exportChat({ format: "jsonl" })
    const text = await readFile(result.path, "utf8")
    expect(text).toContain("日本語のメッセージ")
    expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"))
    expect(result.bytes).toBeGreaterThan(text.length)
  })

  test("a second export of the same range is numbered and leaves the first untouched", async () => {
    f.seedTen()
    const first = await f.exportChat()
    const before = await readFile(first.path, "utf8")
    const second = await f.exportChat()
    const third = await f.exportChat()
    expect([second.file, third.file]).toEqual([`${CHANNEL}-${DAY}-2.md`, `${CHANNEL}-${DAY}-3.md`])
    expect(await readFile(first.path, "utf8")).toBe(before)
    expect(await namesIn(f.folder)).toEqual([first.file, second.file, third.file].sort())
    expect(await modeOf(second.path)).toBe(0o600)
  })

  test("the days in the name are those of the zone", async () => {
    f.seedTen()
    const result = await f.exportChat({ time_zone: "America/Los_Angeles" })
    expect(result.time_zone).toBe("America/Los_Angeles")
    expect(result.file).toBe(`${CHANNEL}-20251214.md`)
    expect(await readFile(result.path, "utf8")).toContain("2025-12-14T21:42:19")
  })

  test("a private chat is exported with its link to @me", async () => {
    store(f, said(DM, 1), said(DM, 2))
    vouch(f, DM, 1, 2, true)
    const result = await f.exportChat({ chat: DM })
    expect(result).toMatchObject({ count: 2, chat: { id: DM, kind: "dm", server: null }, complete_to_start: true })
    expect(await readFile(result.path, "utf8")).toContain(`https://discord.com/channels/@me/${DM}/${msgId(1)}`)
  })

  test("makes no request to Discord and writes nothing to the mirror", async () => {
    f.seedTen()
    const before = f.inspect((mirror) => mirror.prepare("SELECT COUNT(*) AS n FROM messages").get())
    await f.exportChat()
    expect(f.discord.api).toEqual([])
    expect(f.inspect((mirror) => mirror.prepare("SELECT COUNT(*) AS n FROM messages").get())).toEqual(before)
  })
})

describe("where it stops", () => {
  test("a chat no sync run marked lately still exports, and says it is not current", async () => {
    f.seedTen()
    markSynced(f, STALE_AGO, CHANNEL)
    const result = await f.exportChat()
    expect(result.current).toBe(false)
    expect(await readFile(result.path, "utf8")).toContain(
      "Current (a sync run marked the chat in the last 15 minutes): no",
    )
  })

  test("a complete history reaches the start, and has nothing older to continue with", async () => {
    f.seedTen(true)
    const result = await f.exportChat()
    expect(result).toMatchObject({
      complete_to_start: true,
      continue: { older: null, backfill_first: false, newer: null },
    })
  })

  test("a limit cuts the newest messages' older end and hands out the older hint", async () => {
    f.seedTen()
    const result = await f.exportChat({ limit: 4 })
    expect(result).toMatchObject({
      count: 4,
      truncated: true,
      first: { id: msgId(7) },
      last: { id: msgId(10) },
      continue: { older: { before: msgId(7) }, backfill_first: false, newer: null },
    })
  })

  test("with after, a limit cuts the newer end and hands out the newer hint", async () => {
    f.seedTen()
    const result = await f.exportChat({ after: msgId(2), limit: 3 })
    expect(result).toMatchObject({
      count: 3,
      truncated: true,
      first: { id: msgId(3) },
      last: { id: msgId(5) },
      continue: { older: { before: msgId(3) }, newer: { after: msgId(5) } },
    })
  })

  test("the hints surface in the file as well", async () => {
    f.seedTen()
    const text = await readFile((await f.exportChat({ limit: 4 })).path, "utf8")
    expect(text).toContain(`export again with before=${msgId(7)}`)
  })
})
