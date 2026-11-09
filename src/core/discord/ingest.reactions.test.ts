import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { adjustOwnReaction, emojiKey, ingestMessages } from "./ingest"
import { createTestMirror, rowById, type TestMirror } from "./mirror.testing"
import { CHANNEL, ctxAt, messageObject, msgId } from "./objects.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

function ingest(messages: unknown[], reactions: boolean) {
  t.write(() => ingestMessages(t.mirror, ctxAt(), messages, { reactions }))
}

function storedReactions(id: string): unknown {
  const text = rowById(t.mirror, "messages", id)!.reactions as string | null
  return text === null ? null : JSON.parse(text)
}

const thumbs = { emoji: { id: null, name: "👍" }, count: 3, me: true }
const custom = { emoji: { id: msgId(50), name: "party" }, count: 1, me: false }

describe("emojiKey", () => {
  test("is the character, or name:id for a custom emoji", () => {
    expect(emojiKey({ id: null, name: "👍" })).toBe("👍")
    expect(emojiKey({ id: msgId(50), name: "party" })).toBe(`party:${msgId(50)}`)
    expect(emojiKey({ id: msgId(50), name: null })).toBe(`_:${msgId(50)}`)
  })

  test("is null for no emoji, no name or an invalid id", () => {
    for (const emoji of [null, undefined, "x", {}, { id: null, name: "" }, { id: "bad", name: "x" }]) {
      expect(emojiKey(emoji)).toBeNull()
    }
  })
})

describe("reactions", () => {
  test("a history page stores them as emoji, count and me", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs, custom, { emoji: null, count: 2 }] })], true)
    expect(storedReactions(msgId(1))).toEqual([
      { emoji: "👍", count: 3, me: true },
      { emoji: `party:${msgId(50)}`, count: 1, me: false },
    ])
  })

  test("results that are not authoritative leave stored reactions alone", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs] })], true)
    ingest([messageObject(msgId(1), CHANNEL, { content: "edited" })], false)
    expect(storedReactions(msgId(1))).toEqual([{ emoji: "👍", count: 3, me: true }])
    expect(rowById(t.mirror, "messages", msgId(1))).toMatchObject({ content: "edited" })
  })

  test("a new message stored without them has none", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs] })], false)
    expect(storedReactions(msgId(1))).toBeNull()
  })

  test("a history page without reactions clears them", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs] })], true)
    ingest([messageObject(msgId(1), CHANNEL)], true)
    expect(storedReactions(msgId(1))).toBeNull()
  })
})

describe("adjustOwnReaction", () => {
  const heart = { emoji: { id: null, name: "❤️" }, count: 1, me: false }
  const adjust = (emoji: string, add: boolean, id = msgId(1)) =>
    t.write(() => adjustOwnReaction(t.mirror, id, emoji, add))

  test("adding counts the account in on an entry it was not in", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [heart, thumbs] })], true)
    expect(adjust("❤️", true)).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(storedReactions(msgId(1))).toEqual([
      { emoji: "❤️", count: 2, me: true },
      { emoji: "👍", count: 3, me: true },
    ])
  })

  test("adding what the account already added changes nothing", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs] })], true)
    expect(adjust("👍", true)).toEqual({ stored: 0, deleted: 0, skipped: 0 })
    expect(storedReactions(msgId(1))).toEqual([{ emoji: "👍", count: 3, me: true }])
  })

  test("adding a new emoji appends an entry, also to a message with no reactions", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs] }), messageObject(msgId(2), CHANNEL)], true)
    adjust(`party:${msgId(50)}`, true)
    adjust("👍", true, msgId(2))
    expect(storedReactions(msgId(1))).toEqual([
      { emoji: "👍", count: 3, me: true },
      { emoji: `party:${msgId(50)}`, count: 1, me: true },
    ])
    expect(storedReactions(msgId(2))).toEqual([{ emoji: "👍", count: 1, me: true }])
  })

  test("removing takes the account out of the count and keeps the entry", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [thumbs] })], true)
    expect(adjust("👍", false)).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(storedReactions(msgId(1))).toEqual([{ emoji: "👍", count: 2, me: false }])
  })

  test("removing the last reaction drops the entry, and the column is null when none is left", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [{ ...thumbs, count: 1 }, heart] })], true)
    adjust("👍", false)
    expect(storedReactions(msgId(1))).toEqual([{ emoji: "❤️", count: 1, me: false }])
    ingest([messageObject(msgId(2), CHANNEL, { reactions: [{ ...thumbs, count: 1 }] })], true)
    adjust("👍", false, msgId(2))
    expect(rowById(t.mirror, "messages", msgId(2))!.reactions).toBeNull()
  })

  test("removing what the account did not add, or what is not there, changes nothing", () => {
    ingest([messageObject(msgId(1), CHANNEL, { reactions: [heart] }), messageObject(msgId(2), CHANNEL)], true)
    expect(adjust("❤️", false).stored).toBe(0)
    expect(adjust("👍", false).stored).toBe(0)
    expect(adjust("👍", false, msgId(2)).stored).toBe(0)
    expect(storedReactions(msgId(1))).toEqual([{ emoji: "❤️", count: 1, me: false }])
    expect(rowById(t.mirror, "messages", msgId(2))!.reactions).toBeNull()
  })

  test("a message the mirror does not hold, or an invalid id, is skipped", () => {
    expect(adjust("👍", true, msgId(9))).toEqual({ stored: 0, deleted: 0, skipped: 1 })
    expect(adjust("👍", true, "latest")).toEqual({ stored: 0, deleted: 0, skipped: 1 })
  })

  test.each(["[1", "{}", '[{"emoji":"👍"}]'])("a column that is not shaped as stored (%s) is left alone", (text) => {
    ingest([messageObject(msgId(1), CHANNEL)], true)
    t.mirror.prepare("UPDATE messages SET reactions = ? WHERE id = ?").run(text, BigInt(msgId(1)))
    expect(adjust("👍", true)).toEqual({ stored: 0, deleted: 0, skipped: 1 })
    expect(rowById(t.mirror, "messages", msgId(1))!.reactions).toBe(text)
  })
})
