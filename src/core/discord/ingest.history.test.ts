import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { deleteMessage, ingestHistoryPage, ingestMessages } from "./ingest"
import { createTestMirror, rowsOf, storedMessageIds, type TestMirror } from "./mirror.testing"
import { CHANNEL, ctxAt, messageObject, msgId, OTHER_CHANNEL } from "./objects.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

const inChannel = (channel: string, ...numbers: number[]) => numbers.map((n) => messageObject(msgId(n), channel))

function seed(channel: string, ...numbers: number[]) {
  t.write(() => ingestMessages(t.mirror, ctxAt(), inChannel(channel, ...numbers), { reactions: true }))
}

function page(messages: unknown[], after: number | string, before: number | string, channel = CHANNEL) {
  const bound = (value: number | string) => (typeof value === "number" ? msgId(value) : value)
  return t.write(() =>
    ingestHistoryPage(t.mirror, ctxAt(2), channel, messages, { after: bound(after), before: bound(before) }),
  )
}

describe("ingestHistoryPage", () => {
  test("stores the page and deletes mirrored messages strictly inside the range that it did not return", () => {
    seed(CHANNEL, 1, 2, 3, 4, 5, 6)
    const counts = page(inChannel(CHANNEL, 3, 5), 1, 6)
    expect(counts).toEqual({ stored: 2, deleted: 2, skipped: 0 })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(1), msgId(3), msgId(5), msgId(6)])
  })

  test("keeps messages at the range edges and outside it", () => {
    seed(CHANNEL, 1, 2, 5, 8, 9)
    expect(page(inChannel(CHANNEL, 5), 2, 8)).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(1), msgId(2), msgId(5), msgId(8), msgId(9)])
  })

  test("never touches another channel, even inside the range", () => {
    seed(CHANNEL, 2, 3)
    seed(OTHER_CHANNEL, 12, 13, 14)
    page(inChannel(CHANNEL, 3), 1, 99)
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(3)])
    expect(storedMessageIds(t.mirror, OTHER_CHANNEL)).toEqual([msgId(12), msgId(13), msgId(14)])
  })

  test("skips and counts messages of another channel, storing nothing of them", () => {
    const counts = page([...inChannel(CHANNEL, 2), ...inChannel(OTHER_CHANNEL, 3), null], 1, 9)
    expect(counts).toEqual({ stored: 1, deleted: 0, skipped: 2 })
    expect(storedMessageIds(t.mirror, OTHER_CHANNEL)).toEqual([])
  })

  test("an empty page deletes everything inside its range", () => {
    seed(CHANNEL, 2, 3, 9)
    expect(page([], 1, 5)).toEqual({ stored: 0, deleted: 2, skipped: 0 })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(9)])
  })

  test("a start of 0 reaches the first message", () => {
    seed(CHANNEL, 2, 3)
    expect(page([], "0", 9).deleted).toBe(2)
  })

  test("an invalid range deletes nothing but still stores the page", () => {
    seed(CHANNEL, 2, 3)
    for (const [after, before] of [
      ["x", msgId(9)],
      [msgId(1), "x"],
      ["", ""],
    ] as const) {
      expect(page(inChannel(CHANNEL, 4), after, before)).toMatchObject({ stored: 1, deleted: 0 })
    }
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(2), msgId(3), msgId(4)])
  })

  test("a range whose after is not below before deletes nothing", () => {
    seed(CHANNEL, 2, 3)
    expect(page([], 5, 1).deleted).toBe(0)
    expect(page([], 2, 2).deleted).toBe(0)
  })

  test("replaces reactions, as a history page is authoritative for them", () => {
    seed(CHANNEL, 2)
    const reacted = messageObject(msgId(2), CHANNEL, {
      reactions: [{ emoji: { id: null, name: "👍" }, count: 1, me: false }],
    })
    page([reacted], 1, 9)
    expect(rowsOf(t.mirror, "SELECT reactions FROM messages")).toEqual([
      { reactions: JSON.stringify([{ emoji: "👍", count: 1, me: false }]) },
    ])
  })
})

describe("deleteMessage", () => {
  test("removes one message by id", () => {
    seed(CHANNEL, 1, 2)
    expect(t.write(() => deleteMessage(t.mirror, msgId(1)))).toEqual({ stored: 0, deleted: 1, skipped: 0 })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(2)])
  })

  test("counts an unknown id as deleted nothing and an invalid one as skipped", () => {
    expect(t.write(() => deleteMessage(t.mirror, msgId(7)))).toEqual({ stored: 0, deleted: 0, skipped: 0 })
    expect(t.write(() => deleteMessage(t.mirror, "x"))).toEqual({ stored: 0, deleted: 0, skipped: 1 })
  })
})
