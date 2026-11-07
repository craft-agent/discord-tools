import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestMessages, ingestOlderHistory } from "./ingest"
import { createTestMirror, storedMessageIds, type TestMirror } from "./mirror.testing"
import { getCursor, markCurrent, markRechecked, setCursorEdges } from "./mirror-cursors"
import { CHANNEL, ctxAt, messageObject, msgId } from "./objects.testing"
import { historyPage } from "./sync-page"

const SYNCED_AT = 1000
const RECHECKED_AT = 2000

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

const inChannel = (...numbers: number[]) => numbers.map((n) => messageObject(msgId(n), CHANNEL))

/** A mirror holding messages 6 to 9 with the cursor at 6..9, marked current. */
function seedFollowed(...extra: number[]) {
  t.write(() => {
    ingestMessages(t.mirror, ctxAt(), inChannel(...extra, 6, 7, 8, 9), { reactions: true })
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(9), oldest: msgId(6) })
    markCurrent(t.mirror, CHANNEL, SYNCED_AT)
    markRechecked(t.mirror, CHANNEL, RECHECKED_AT)
  })
}

const older = (limit: number, before: number, ...numbers: number[]) =>
  historyPage(inChannel(...numbers).reverse(), CHANNEL, limit, msgId(before))

describe("ingestOlderHistory", () => {
  test("stores the page, widens oldest and leaves newest, synced_at and rechecked_at alone", () => {
    seedFollowed()
    const counts = t.write(() => ingestOlderHistory(t.mirror, ctxAt(), CHANNEL, older(3, 6, 3, 4, 5)))
    expect(counts).toEqual({ stored: 3, deleted: 0, skipped: 0 })
    expect(getCursor(t.mirror, CHANNEL)).toEqual({
      newest: msgId(9),
      oldest: msgId(3),
      complete: false,
      syncedAt: SYNCED_AT,
      recheckedAt: RECHECKED_AT,
    })
  })

  test("a short page sets complete", () => {
    seedFollowed()
    t.write(() => ingestOlderHistory(t.mirror, ctxAt(), CHANNEL, older(5, 6, 4, 5)))
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ oldest: msgId(4), complete: true })
  })

  test("an empty page keeps oldest and sets complete", () => {
    seedFollowed()
    t.write(() => ingestOlderHistory(t.mirror, ctxAt(), CHANNEL, older(5, 6)))
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ oldest: msgId(6), complete: true })
  })

  test("deletes only inside the page's range", () => {
    seedFollowed(1, 4)
    const counts = t.write(() => ingestOlderHistory(t.mirror, ctxAt(), CHANNEL, older(2, 6, 3, 5)))
    expect(counts).toEqual({ stored: 2, deleted: 1, skipped: 0 })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([1, 3, 5, 6, 7, 8, 9].map(msgId))
  })
})
