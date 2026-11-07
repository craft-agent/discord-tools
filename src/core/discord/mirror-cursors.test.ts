import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestChannels, ingestHistoryPage, ingestMessages, ingestServers, ingestUsers } from "./ingest"
import { CURRENT_MS, getCursor, isChannelCurrent, markCurrent, markRechecked, setCursorEdges } from "./mirror-cursors"
import { createTestMirror, rowsOf, type TestMirror } from "./mirror.testing"
import {
  ALICE,
  CHANNEL,
  channelObject,
  ctxAt,
  messageObject,
  msgId,
  SERVER,
  serverObject,
  userObject,
} from "./objects.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

describe("getCursor", () => {
  test("is undefined for a channel without one or an invalid id", () => {
    expect(getCursor(t.mirror, CHANNEL)).toBeUndefined()
    expect(getCursor(t.mirror, "x")).toBeUndefined()
  })
})

describe("setCursorEdges", () => {
  test("creates a cursor with ids as exact text", () => {
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(9), oldest: msgId(3) })
    expect(getCursor(t.mirror, CHANNEL)).toEqual({
      newest: msgId(9),
      oldest: msgId(3),
      complete: false,
      syncedAt: null,
      recheckedAt: null,
    })
  })

  test("newest only grows and oldest only shrinks, numerically", () => {
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(5), oldest: msgId(5) })
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(4), oldest: msgId(6) })
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ newest: msgId(5), oldest: msgId(5) })
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(8), oldest: msgId(2) })
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ newest: msgId(8), oldest: msgId(2) })
    setCursorEdges(t.mirror, CHANNEL, { newest: "999999999999999999", oldest: "1000000000000000000" })
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ newest: msgId(8), oldest: "1000000000000000000" })
  })

  test("a missing or invalid edge changes nothing, and one given alone fills a missing one", () => {
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(5) })
    setCursorEdges(t.mirror, CHANNEL, { oldest: msgId(3), newest: "x" })
    setCursorEdges(t.mirror, CHANNEL, {})
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ newest: msgId(5), oldest: msgId(3), complete: false })
    setCursorEdges(t.mirror, "x", { newest: msgId(9) })
    expect(rowsOf(t.mirror, "SELECT count(*) AS n FROM cursors")).toEqual([{ n: 1 }])
  })

  test("complete only goes from false to true", () => {
    setCursorEdges(t.mirror, CHANNEL, { complete: false })
    expect(getCursor(t.mirror, CHANNEL)?.complete).toBe(false)
    setCursorEdges(t.mirror, CHANNEL, { complete: true })
    setCursorEdges(t.mirror, CHANNEL, { complete: false })
    setCursorEdges(t.mirror, CHANNEL, {})
    expect(getCursor(t.mirror, CHANNEL)?.complete).toBe(true)
  })
})

describe("markRechecked and markCurrent", () => {
  test("each sets its own time and leaves the edges and the other time", () => {
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(5), complete: true })
    markRechecked(t.mirror, CHANNEL, 11)
    markCurrent(t.mirror, CHANNEL, 22)
    expect(getCursor(t.mirror, CHANNEL)).toEqual({
      newest: msgId(5),
      oldest: null,
      complete: true,
      syncedAt: 22,
      recheckedAt: 11,
    })
    markCurrent(t.mirror, CHANNEL, 33)
    expect(getCursor(t.mirror, CHANNEL)).toMatchObject({ syncedAt: 33, recheckedAt: 11 })
  })

  test("create a cursor for a channel without one, and ignore an invalid id", () => {
    markCurrent(t.mirror, CHANNEL, 5)
    markRechecked(t.mirror, "x", 5)
    markCurrent(t.mirror, "x", 5)
    expect(
      rowsOf(t.mirror, "SELECT CAST(channel AS TEXT) AS c, synced_at, rechecked_at, complete FROM cursors"),
    ).toEqual([{ c: CHANNEL, synced_at: 5, rechecked_at: null, complete: 0 }])
  })

  test("no ingest function sets a cursor or synced_at", () => {
    const ctx = ctxAt()
    t.write(() => {
      ingestServers(t.mirror, ctx, [serverObject(SERVER)])
      ingestChannels(t.mirror, ctx, [channelObject(CHANNEL)], SERVER)
      ingestUsers(t.mirror, ctx, [userObject(ALICE)])
      ingestMessages(t.mirror, ctx, [messageObject(msgId(1), CHANNEL)], { reactions: true })
      ingestHistoryPage(t.mirror, ctx, CHANNEL, [messageObject(msgId(2), CHANNEL)], {
        after: msgId(0),
        before: msgId(9),
      })
    })
    expect(rowsOf(t.mirror, "SELECT count(*) AS n FROM cursors")).toEqual([{ n: 0 }])
    markCurrent(t.mirror, CHANNEL, 7)
    expect(rowsOf(t.mirror, "SELECT synced_at FROM cursors")).toEqual([{ synced_at: 7 }])
  })
})

describe("isChannelCurrent", () => {
  test("is false for a channel without a cursor or never marked current", () => {
    expect(isChannelCurrent(t.mirror, CHANNEL, 1000)).toBe(false)
    setCursorEdges(t.mirror, CHANNEL, { newest: msgId(5) })
    expect(isChannelCurrent(t.mirror, CHANNEL, 1000)).toBe(false)
  })

  test("is true for under CURRENT_MS after the mark and false from then on", () => {
    markCurrent(t.mirror, CHANNEL, 1000)
    expect(isChannelCurrent(t.mirror, CHANNEL, 1000)).toBe(true)
    expect(isChannelCurrent(t.mirror, CHANNEL, 1000 + CURRENT_MS - 1)).toBe(true)
    expect(isChannelCurrent(t.mirror, CHANNEL, 1000 + CURRENT_MS)).toBe(false)
  })

  test("is 15 minutes", () => {
    expect(CURRENT_MS).toBe(900_000)
  })
})
