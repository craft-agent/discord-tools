import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { emojiKey, ingestMessages } from "./ingest"
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
