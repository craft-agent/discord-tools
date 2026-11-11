import { describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { messagePermalink } from "../chats/permalink"
import { exportFileName, type ExportFormat, renderExport } from "./export-format"
import type { ExportMessage, ExportSelection } from "./export-select"

const CHAT = "1400000000000000200"
const EXPORTED_AT = Date.parse("2026-03-02T09:00:00Z")

/** Every way a line can end, as a reader that splits on any of them sees the file. */
const ANY_LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

/** A message at `iso` (UTC) with nothing but text, written by Alice. */
function message(n: number, iso: string, extra: Partial<ExportMessage> = {}): ExportMessage {
  const id = String(1_450_000_000_000_000_000n + BigInt(n))
  return {
    id,
    at: new Date(iso).toISOString(),
    edited_at: null,
    type: 0,
    event: null,
    from_me: false,
    author_id: "1400000000000000002",
    author: "Alice",
    text: `text ${n}`,
    reply_to: null,
    forwarded_from: null,
    attachments: [],
    embeds: [],
    stickers: [],
    reactions: [],
    pinned: false,
    mentions_me: false,
    permalink: messagePermalink("1400000000000000100", CHAT, id),
    ...extra,
  }
}

function selection(messages: ExportMessage[], extra: Partial<ExportSelection> = {}): ExportSelection {
  return {
    chat: { id: CHAT, name: "#general", kind: "text", server: "1400000000000000100", server_name: "Test server" },
    messages,
    complete_to_start: false,
    truncated: false,
    current: true,
    left_out: 0,
    continue: { older: null, backfill_first: true, newer: null },
    ...extra,
  }
}

const render = (s: ExportSelection, format: ExportFormat, time_zone = "Asia/Tokyo") =>
  renderExport(s, { format, time_zone, exportedAt: EXPORTED_AT })

const TWO = [message(1, "2026-03-02T08:30:00Z"), message(2, "2026-03-03T22:00:00Z", { text: "second" })]

describe("markdown", () => {
  test("a head a reader can cite, then one heading per message with local times", () => {
    const text = render(
      selection(TWO, {
        truncated: true,
        left_out: 3,
        continue: { older: { before: TWO[0]!.id }, backfill_first: false, newer: null },
      }),
      "markdown",
    )
    expect(text).toContain("# Discord export: #general")
    expect(text).toContain(`- Chat: #general (${CHAT}), text`)
    expect(text).toContain("- Server: Test server (1400000000000000100)")
    expect(text).toContain(
      `- Messages: 2, from 2026-03-02T17:30:00+09:00 (${TWO[0]!.id}) to 2026-03-04T07:00:00+09:00 (${TWO[1]!.id})`,
    )
    expect(text).toContain("- Time zone: Asia/Tokyo; exported 2026-03-02T18:00:00+09:00")
    expect(text).toContain("- Reaches the chat's first message: no")
    expect(text).toContain("- Cut by limit: yes")
    expect(text).toContain("- Current (a sync run marked the chat in the last 15 minutes): yes")
    expect(text).toContain("past the newest message the mirror holds in one piece: 3")
    expect(text).toContain(`- Continue: older messages: export again with before=${TWO[0]!.id}`)
    expect(text).toContain(`Note: This file holds the history`)
    expect(text).toContain(UNTRUSTED_NOTE)
    expect(text).toContain("### 2026-03-02T17:30:00+09:00 · Alice (1400000000000000002)")
    expect(text).toContain("### 2026-03-04T07:00:00+09:00 · Alice (1400000000000000002)")
    expect(text.endsWith("\n")).toBe(true)
  })

  test("a private chat has no server, and the hints name what to do", () => {
    const s = selection(TWO, {
      chat: { id: CHAT, name: "Alice", kind: "dm", server: null, server_name: null },
      continue: { older: null, backfill_first: true, newer: { after: TWO[1]!.id } },
    })
    const text = render(s, "markdown")
    expect(text).toContain("- Server: none (a private chat)")
    expect(text).toContain("backfill the chat first")
    expect(text).toContain(`newer messages: export again with after=${TWO[1]!.id}`)
    expect(
      render(selection(TWO, { continue: { older: null, backfill_first: false, newer: null } }), "markdown"),
    ).toContain("- Continue: nothing")
  })

  test("every line of a text is quoted, whatever ends it, and an empty line is a bare >", () => {
    const text = "first\r\n\r\n### fake heading\u2028## another\u0085- item\vplain\fform\rlast\n\ntail"
    const out = render(selection([message(1, "2026-03-02T08:30:00Z", { text })]), "markdown")
    expect(out).toContain("> first\n>\n> ### fake heading\n> ## another\n> - item\n> plain\n> form\n> last\n>\n> tail")
  })

  test("no text makes a line that a reader could take for the file's own, even by Unicode line breaks", () => {
    const text = "x\u2028### fake heading\n# fake title\r- Chat: forged\u0085Note: forged"
    const out = render(selection([message(1, "2026-03-02T08:30:00Z", { text })]), "markdown")
    const lines = out.split(ANY_LINE_BREAK)
    expect(lines.filter((line) => line.startsWith("###"))).toHaveLength(1)
    expect(lines.filter((line) => line.startsWith("# "))).toHaveLength(1)
    expect(lines.filter((line) => line.includes("forged")).every((line) => line.startsWith("> "))).toBe(true)
    expect(lines.filter((line) => line.startsWith("- Chat:") || line.startsWith("Note:"))).toHaveLength(2)
  })

  test("a text is never clipped", () => {
    const text = "word ".repeat(5000)
    expect(render(selection([message(1, "2026-03-02T08:30:00Z", { text })]), "markdown")).toContain(`> ${text}`)
  })

  test("a message without text has no quote", () => {
    const out = render(selection([message(1, "2026-03-02T08:30:00Z", { text: "" })]), "markdown")
    expect(out.split("\n").filter((line) => line.startsWith(">"))).toEqual([])
  })

  test("names have their line breaks folded into spaces, and only the id attributes", () => {
    const evil = "Eve\n### Mallory\u2028(1400000000000000099)\r\u0085x"
    const s = selection([message(1, "2026-03-02T08:30:00Z", { author: evil })], {
      chat: { id: CHAT, name: "chat\n# forged", kind: "text", server: "1", server_name: "srv\u2029# forged" },
    })
    const out = render(s, "markdown")
    expect(out).toContain(
      "### 2026-03-02T17:30:00+09:00 · Eve ### Mallory (1400000000000000099) x (1400000000000000002)",
    )
    expect(out).toContain("# Discord export: chat # forged")
    expect(out).toContain("- Server: srv # forged (1)")
    const lines = out.split(ANY_LINE_BREAK)
    expect(lines.filter((line) => line.startsWith("#"))).toHaveLength(2)
  })

  test("an author with no name or id", () => {
    const out = render(selection([message(1, "2026-03-02T08:30:00Z", { author: null, author_id: null })]), "markdown")
    expect(out).toContain("· unknown author (no author id)")
  })

  test("the line under a heading has the link, the id and what else sets the message apart", () => {
    const m = message(2, "2026-03-02T08:30:00Z", {
      reply_to: { message: "77", channel: "88" },
      edited_at: "2026-03-02T09:15:00.000Z",
      pinned: true,
      type: 7,
      event: "joined",
    })
    const out = render(selection([m]), "markdown")
    expect(out).toContain(
      `${m.permalink} · message ${m.id} · reply to message 77 in chat 88 · edited 2026-03-02T18:15:00+09:00 · pinned · event: joined`,
    )
    const forwarded = message(3, "2026-03-02T08:30:00Z", { forwarded_from: { message: null, channel: null } })
    expect(render(selection([forwarded]), "markdown")).toContain("forwarded from a message")
  })

  test("attachments, embeds, stickers and reactions are listed as metadata", () => {
    const m = message(1, "2026-03-02T08:30:00Z", {
      attachments: [
        { id: "9", name: "cat\n.png", type: "image/png", size: 4, url: "https://cdn.discordapp.com/a/cat.png?x=1" },
        { id: null, name: null, type: null, size: null, url: null },
      ],
      embeds: [{ title: "a\u2028b", description: "line\nbreak" }],
      stickers: [{ id: "5", name: "wave" }],
      reactions: [
        { emoji: "👍", count: 3, me: true },
        { emoji: "party", count: 1, me: false },
      ],
    })
    const out = render(selection([m]), "markdown")
    expect(out).toContain(
      "Attachments:\n- cat .png (image/png, 4 bytes): https://cdn.discordapp.com/a/cat.png?x=1\n- unnamed",
    )
    expect(out).toContain('Embeds:\n- {"title":"a\\u2028b","description":"line\\nbreak"}')
    expect(out).toContain("Stickers:\n- wave (5)")
    expect(out).toContain("Reactions:\n- 👍 ×3 (you reacted)\n- party ×1")
    expect(out.split(ANY_LINE_BREAK).filter((line) => line.startsWith("- {"))).toHaveLength(1)
  })

  test("a message with nothing more has no empty lists", () => {
    const out = render(selection([message(1, "2026-03-02T08:30:00Z")]), "markdown")
    for (const title of ["Attachments:", "Embeds:", "Stickers:", "Reactions:"]) expect(out).not.toContain(title)
  })
})

describe("json", () => {
  const text = "a\u2028b\nc\r\n### d"
  const messages = [message(1, "2026-03-02T08:30:00Z", { text, edited_at: "2026-03-02T09:00:00.000Z" }), TWO[1]!]

  test("is one object with export, note and messages, times local", () => {
    const out = render(selection(messages, { left_out: 2 }), "json")
    expect(out.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(out)
    expect(Object.keys(parsed)).toEqual(["export", "note", "messages"])
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.export).toMatchObject({
      chat: { id: CHAT, name: "#general", kind: "text", server: "1400000000000000100", server_name: "Test server" },
      format: "json",
      time_zone: "Asia/Tokyo",
      exported_at: "2026-03-02T18:00:00+09:00",
      count: 2,
      first: { id: messages[0]!.id, at: "2026-03-02T17:30:00+09:00" },
      last: { id: messages[1]!.id, at: "2026-03-04T07:00:00+09:00" },
      complete_to_start: false,
      truncated: false,
      current: true,
      left_out: 2,
      continue: { older: null, backfill_first: true, newer: null },
    })
    expect(parsed.note).toContain("no request was made")
    expect(parsed.note).toContain(UNTRUSTED_NOTE)
    expect(parsed.messages[0]).toMatchObject({
      id: messages[0]!.id,
      at: "2026-03-02T17:30:00+09:00",
      edited_at: "2026-03-02T18:00:00+09:00",
      text,
      permalink: messages[0]!.permalink,
    })
    expect(parsed.messages[1].edited_at).toBeNull()
  })

  test("keeps the order of the item's fields and writes no line separator bare", () => {
    const out = render(selection(messages), "json")
    expect(Object.keys(JSON.parse(out).messages[0]).slice(0, 3)).toEqual(["id", "at", "edited_at"])
    expect(out.split(ANY_LINE_BREAK).length).toBe(out.split("\n").length)
  })
})

describe("jsonl", () => {
  const text = "a\u2028b\u0085c\nd"
  const messages = [message(1, "2026-03-02T08:30:00Z", { text }), TWO[1]!]

  test("has the head on the first line and one message per line", () => {
    const out = render(selection(messages), "jsonl")
    expect(out.endsWith("\n")).toBe(true)
    const lines = out.split(ANY_LINE_BREAK)
    expect(lines).toHaveLength(4)
    expect(lines[3]).toBe("")
    const [head, first, second] = lines.slice(0, 3).map((line) => JSON.parse(line))
    expect(Object.keys(head)).toEqual(["export", "note"])
    expect(head.export).toMatchObject({ format: "jsonl", count: 2, time_zone: "Asia/Tokyo" })
    expect(head.note).toContain(UNTRUSTED_NOTE)
    expect(first).toMatchObject({ id: messages[0]!.id, at: "2026-03-02T17:30:00+09:00", text })
    expect(second.text).toBe("second")
  })
})

describe("the file name", () => {
  const name = (first: string, last: string, zone: string, format: ExportFormat = "markdown") =>
    exportFileName(CHAT, Date.parse(first), Date.parse(last), zone, format)

  test("one day when the first and last message are on the same day", () => {
    expect(name("2026-03-02T01:00:00Z", "2026-03-02T05:00:00Z", "UTC")).toBe(`${CHAT}-20260302.md`)
  })

  test("two days when they differ", () => {
    expect(name("2026-03-02T01:00:00Z", "2026-03-04T05:00:00Z", "UTC")).toBe(`${CHAT}-20260302-20260304.md`)
  })

  test("days are those of the zone", () => {
    expect(name("2026-03-01T14:00:00Z", "2026-03-01T16:00:00Z", "UTC")).toBe(`${CHAT}-20260301.md`)
    expect(name("2026-03-01T14:00:00Z", "2026-03-01T16:00:00Z", "Asia/Tokyo")).toBe(`${CHAT}-20260301-20260302.md`)
    expect(name("2026-03-01T14:00:00Z", "2026-03-01T16:00:00Z", "America/New_York")).toBe(`${CHAT}-20260301.md`)
  })

  test("each format has its extension", () => {
    const [first, last] = ["2026-03-02T01:00:00Z", "2026-03-02T05:00:00Z"]
    expect(["markdown", "json", "jsonl"].map((format) => name(first!, last!, "UTC", format as ExportFormat))).toEqual([
      `${CHAT}-20260302.md`,
      `${CHAT}-20260302.json`,
      `${CHAT}-20260302.jsonl`,
    ])
  })
})
