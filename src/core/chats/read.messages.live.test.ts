import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { markCurrent, setCursorEdges } from "../discord/mirror-cursors"
import { rowsOf, storedMessageIds } from "../discord/mirror.testing"
import { CHANNEL, messageObject, msgId, OTHER_CHANNEL } from "../discord/objects.testing"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"
import {
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

const messages = (args: Record<string, unknown> = {}) => f.read({ method: "messages", channel: CHANNEL, ...args })
const stored = () => f.inspect((m) => storedMessageIds(m, CHANNEL))
const cursors = () =>
  f.inspect((m) =>
    rowsOf(
      m,
      "SELECT CAST(newest AS TEXT) AS newest, CAST(oldest AS TEXT) AS oldest, complete, synced_at FROM cursors",
    ),
  )

describe("method messages from Discord, backward", () => {
  test("stores the page, answers oldest first, pages back and never marks the channel current", async () => {
    f.seed((m) => {
      setCursorEdges(m, CHANNEL, { newest: msgId(9), oldest: msgId(8) })
      markCurrent(m, CHANNEL, STALE_SYNC)
    })
    const before = cursors()
    serveHistory(f, history(1, 2, 3, 4, 5))

    const first = await messages({ limit: 3 })
    expect(first).toMatchObject({ source: "live", channel: CHANNEL, next_after: null })
    expect(messageIds(first)).toEqual(idsOf(3, 4, 5))
    expect(first.next_before).toBe(idsOf(3)[0]!)
    expect(historyRequests(f)[0]!.query.get("limit")).toBe("3")
    expect(historyRequests(f)[0]!.query.has("before")).toBe(false)
    expect(stored()).toEqual(idsOf(3, 4, 5))

    const second = await messages({ limit: 3, before: first.next_before })
    expect(messageIds(second)).toEqual(idsOf(1, 2))
    expect(second.next_before).toBeNull()
    expect(historyRequests(f)[1]!.query.get("before")).toBe(idsOf(3)[0]!)
    expect(stored()).toEqual(idsOf(1, 2, 3, 4, 5))
    expect(cursors()).toEqual(before)
  })

  test("a page vouches for its range: a mirrored message Discord did not return is deleted, nothing outside is", async () => {
    seedHistory(f, [1, 2, 3, 4, 5], { complete: true })
    f.seed((m) => markCurrent(m, CHANNEL, STALE_SYNC))
    seedHistory(f, [4], { channel: OTHER_CHANNEL })
    serveHistory(f, history(1, 2, 3, 5))
    const result = await messages({ limit: 2 })
    expect(messageIds(result)).toEqual(idsOf(3, 5))
    expect(stored()).toEqual(idsOf(1, 2, 3, 5))
    expect(f.inspect((m) => storedMessageIds(m, OTHER_CHANNEL))).toEqual(idsOf(4))
  })

  test("an empty page served for a request with before deletes nothing and ends paging with null next_before", async () => {
    seedHistory(f, [1, 2, 3], { complete: true })
    serveHistory(f, [])
    const result = await messages({ before: idsOf(4)[0], limit: 5 })
    expect(result.next_before).toBeNull()
    expect(result.messages).toEqual([])
    expect(stored()).toEqual(idsOf(1, 2, 3))
  })

  test("the after floor drops what is not above it and ends the paging", async () => {
    serveHistory(f, history(1, 2, 3, 4, 5))
    const top = idsOf(6)[0]
    const cut = await messages({ after: idsOf(3)[0], before: top })
    expect(messageIds(cut)).toEqual(idsOf(4, 5))
    expect(cut.next_before).toBeNull()
    const full = await messages({ after: idsOf(1)[0], before: top, limit: 2 })
    expect(messageIds(full)).toEqual(idsOf(4, 5))
    expect(full.next_before).toBe(idsOf(4)[0]!)
    const exact = await messages({ after: idsOf(3)[0], before: top, limit: 3 })
    expect(messageIds(exact)).toEqual(idsOf(4, 5))
    expect(exact.next_before).toBeNull()
  })

  test("before and after dates become snowflake bounds in the request", async () => {
    serveHistory(f, [])
    await messages({ before: "2026-01-02" })
    expect(historyRequests(f)[0]!.query.get("before")).toMatch(/^\d{18,19}$/)
  })

  test("a short page ends the paging", async () => {
    serveHistory(f, history(1, 2))
    expect((await messages({ limit: 5 })).next_before).toBeNull()
    serveHistory(f, [])
    const empty = await messages({ limit: 5 })
    expect(empty).toMatchObject({ messages: [], next_before: null, next_after: null })
  })
})

describe("method messages from Discord, forward", () => {
  test("reads the oldest messages above after, stores them and pages with next_after", async () => {
    f.seed((m) => {
      setCursorEdges(m, CHANNEL, { newest: msgId(9), oldest: msgId(8) })
      markCurrent(m, CHANNEL, STALE_SYNC)
    })
    const before = cursors()
    serveHistory(f, history(1, 2, 3, 4, 5))
    const first = await messages({ after: idsOf(1)[0], limit: 2 })
    expect(first).toMatchObject({ source: "live", next_before: null, next_after: idsOf(3)[0] })
    expect(messageIds(first)).toEqual(idsOf(2, 3))
    expect(historyRequests(f)[0]!.query.get("after")).toBe(idsOf(1)[0]!)
    expect(historyRequests(f)[0]!.query.has("before")).toBe(false)
    const second = await messages({ after: first.next_after, limit: 5 })
    expect(messageIds(second)).toEqual(idsOf(4, 5))
    expect(second.next_after).toBeNull()
    expect(stored()).toEqual(idsOf(2, 3, 4, 5))
    expect(cursors()).toEqual(before)
  })

  test("a page vouches only between after and its newest message", async () => {
    seedHistory(f, [1, 2, 3, 4, 5, 6], { complete: true })
    serveHistory(f, history(1, 2, 4, 5, 6))
    await messages({ after: idsOf(1)[0], limit: 2 })
    expect(stored()).toEqual(idsOf(1, 2, 4, 5, 6))
    serveHistory(f, [])
    await messages({ after: idsOf(5)[0] })
    expect(stored()).toEqual(idsOf(1, 2, 4, 5, 6))
  })
})

describe("method messages: Discord's answer", () => {
  test.each([
    ["not a list", { message: "oops" }],
    ["a message of another channel", [messageObject(msgId(2), "1400000000000000999")]],
    ["oldest first", history(1, 2)],
    ["more than the limit", history(3, 2, 1)],
  ])("%s is an upstream error and stores nothing", async (_name, answer) => {
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: answer })
    expect((await failure(messages({ limit: 2 }))).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test("a forward page with a message at or below after is an upstream error", async () => {
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: history(2, 1) })
    expect((await failure(messages({ after: idsOf(1)[0], limit: 5 }))).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test("a refusal is forbidden and a write is never made", async () => {
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, {
      status: 403,
      json: { code: 50001, message: "Missing Access" },
    })
    expect((await failure(messages())).code).toBe("forbidden")
    expect(stored()).toEqual([])
    expect(historyRequests(f)).toHaveLength(1)
  })
})
