import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestMessages } from "../discord/ingest"
import { CURRENT_MS, markCurrent, setCursorEdges } from "../discord/mirror-cursors"
import { rowsOf, storedMessageIds } from "../discord/mirror.testing"
import { CHANNEL, messageObject, msgId } from "../discord/objects.testing"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"
import {
  CATEGORY,
  FORUM,
  history,
  historyRequests,
  idsOf,
  messageIds,
  seedChannels,
  seedHistory,
  serveHistory,
} from "./read.messages.testing"

const STALE_SYNC = 123

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  seedChannels(f)
})
afterEach(async () => {
  await f.dispose()
})

const around = (n: number, args: Record<string, unknown> = {}) =>
  f.read({ method: "around", channel: CHANNEL, message: msgId(n), ...args })
const stored = () => f.inspect((m) => storedMessageIds(m, CHANNEL))
const cursors = () =>
  f.inspect((m) =>
    rowsOf(
      m,
      "SELECT CAST(newest AS TEXT) AS newest, CAST(oldest AS TEXT) AS oldest, complete, synced_at FROM cursors",
    ),
  )

describe("method around from the mirror", () => {
  test("a current channel that holds the message answers with no request and no token", async () => {
    seedHistory(f, [1, 2, 3, 4, 5, 6, 7, 8, 9], { current: true, complete: true })
    f.ctx.runtime!.env = {}
    const result = await around(5, { before_count: 2, after_count: 3 })
    expect(result).toMatchObject({ method: "around", source: "mirror", channel: CHANNEL, message: msgId(5) })
    expect(messageIds(result)).toEqual(idsOf(3, 4, 5, 6, 7, 8))
    expect(f.discord.requests).toHaveLength(0)
  })

  test("the counts default to 5 and stop at the ends of the channel", async () => {
    seedHistory(f, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], { current: true, complete: true })
    expect(messageIds(await around(7))).toEqual(idsOf(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))
    expect(messageIds(await around(2))).toEqual(idsOf(1, 2, 3, 4, 5, 6, 7))
    expect(messageIds(await around(7, { before_count: 0, after_count: 0 }))).toEqual(idsOf(7))
  })

  test("an incomplete channel answers when it holds enough older messages inside its range", async () => {
    seedHistory(f, [3, 4, 5, 6], { current: true })
    expect(messageIds(await around(5, { before_count: 2, after_count: 9 }))).toEqual(idsOf(3, 4, 5, 6))
    expect(f.discord.requests).toHaveLength(0)
  })

  test.each([
    ["too few older messages are mirrored", 5, { before_count: 3 }],
    ["the message lies below the oldest", 2, {}],
    ["the message is not mirrored", 8, {}],
  ])("falls to Discord when %s", async (_name, anchor, args) => {
    seedHistory(f, [3, 4, 5, 6], { current: true })
    serveHistory(f, history(1, 2, 3, 4, 5, 6, 7, 8, 9))
    expect((await around(anchor, args)).source).toBe("live")
    expect(historyRequests(f)).toHaveLength(1)
  })

  test("falls to Discord for a message stored above the cursor's newest", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    f.seed((m) => ingestMessages(m, f.ingestContext(), [messageObject(msgId(9), CHANNEL)], { reactions: false }))
    serveHistory(f, history(3, 4, 5, 9))
    expect((await around(9, { before_count: 1, after_count: 1 })).source).toBe("live")
    expect(historyRequests(f)).toHaveLength(1)
  })

  test("never includes a message above the cursor's newest among the neighbours", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    f.seed((m) => ingestMessages(m, f.ingestContext(), [messageObject(msgId(9), CHANNEL)], { reactions: false }))
    const result = await around(4, { before_count: 1, after_count: 5 })
    expect(result.source).toBe("mirror")
    expect(messageIds(result)).toEqual(idsOf(3, 4, 5))
    expect(f.discord.requests).toHaveLength(0)
  })

  test("falls to Discord when the channel is not current", async () => {
    seedHistory(f, [1, 2, 3], { current: true, complete: true })
    serveHistory(f, history(1, 2, 3))
    f.advance(CURRENT_MS + 1)
    expect((await around(2)).source).toBe("live")
  })
})

describe("method around from Discord", () => {
  test("asks for a window and trims it to the counts around the message, oldest first", async () => {
    serveHistory(f, history(1, 2, 3, 4, 5, 6, 7, 8, 9))
    const window = await around(5, { before_count: 1, after_count: 1 })
    expect(window).toMatchObject({ source: "live", message: msgId(5) })
    expect(messageIds(window)).toEqual(idsOf(4, 5, 6))
    expect(historyRequests(f)[0]!.query.get("around")).toBe(msgId(5))
    expect(historyRequests(f)[0]!.query.get("limit")).toBe("3")

    const trimmed = await around(5, { before_count: 1, after_count: 3 })
    expect(messageIds(trimmed)).toEqual(idsOf(4, 5, 6, 7, 8))
    expect(historyRequests(f)[1]!.query.get("limit")).toBe("7")
    expect(stored()).toEqual(idsOf(2, 3, 4, 5, 6, 7, 8))
  })

  test("the page size follows the counts: at least 1, at most 100", async () => {
    serveHistory(f, history(1, 2, 3, 4, 5, 6, 7, 8, 9))
    expect(messageIds(await around(5, { before_count: 0, after_count: 0 }))).toEqual(idsOf(5))
    await around(5)
    await around(5, { before_count: 50, after_count: 50 })
    expect(historyRequests(f).map((request) => request.query.get("limit"))).toEqual(["1", "11", "100"])
  })

  test("the counts are at most 50", async () => {
    for (const args of [{ before_count: 51 }, { after_count: 51 }, { before_count: -1 }]) {
      expect((await failure(around(5, args))).code).toBe("invalid_argument")
    }
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a message the page does not hold is not_found", async () => {
    serveHistory(f, history(1, 2, 3, 4, 5))
    for (const n of [9, 0]) {
      const error = await failure(around(n))
      expect(error.code).toBe("not_found")
      expect(error.message).toContain("or was deleted")
    }
    serveHistory(f, [])
    expect((await failure(around(3))).code).toBe("not_found")
  })

  test("the page vouches only strictly between its oldest and newest message", async () => {
    seedHistory(f, [3, 4, 5, 6, 7, 8], { complete: true })
    f.seed((m) => {
      markCurrent(m, CHANNEL, STALE_SYNC)
      setCursorEdges(m, CHANNEL, { newest: msgId(20), oldest: msgId(1) })
    })
    const before = cursors()
    serveHistory(f, history(4, 6, 7))
    const result = await around(6, { before_count: 1, after_count: 1 })
    expect(messageIds(result)).toEqual(idsOf(4, 6, 7))
    expect(stored()).toEqual(idsOf(3, 4, 6, 7, 8))
    expect(cursors()).toEqual(before)
  })

  test("a malformed page is an upstream error and stores nothing", async () => {
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: history(4, 5, 6) })
    expect((await failure(around(5))).code).toBe("upstream_error")
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: { message: "oops" } })
    expect((await failure(around(5))).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })
})

describe("method around: the arguments", () => {
  test("a forum, a category, an unknown channel and bad ids are refused with no request", async () => {
    expect((await failure(around(5, { channel: FORUM }))).code).toBe("invalid_argument")
    expect((await failure(around(5, { channel: CATEGORY }))).code).toBe("invalid_argument")
    expect((await failure(around(5, { channel: "1400000000000000999" }))).code).toBe("not_found")
    expect((await failure(around(5, { message: "latest" }))).code).toBe("invalid_argument")
    expect((await failure(f.read({ method: "around", channel: CHANNEL }))).message).toContain("needs `message`")
    expect((await failure(f.read({ method: "around", message: msgId(1) }))).message).toContain("needs `channel`")
    expect((await failure(around(5, { limit: 5 }))).message).toContain("limit is not an argument of method around")
    expect(f.discord.requests).toHaveLength(0)
  })
})
