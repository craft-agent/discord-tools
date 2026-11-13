import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CATEGORY, FORUM } from "../chats/read.messages.testing"
import { setCursorEdges } from "../discord/mirror-cursors"
import { CHANNEL, DM, msgId, SERVER } from "../discord/objects.testing"
import { markSynced, numbersOf, said, seedWorld, STALE_AGO, store, THREAD } from "../search/search.testing"
import { EXPORT_LIMIT_DEFAULT, EXPORT_LIMIT_MAX } from "./export-select"
import { selectIn, storeMessages, vouch } from "./export.testing"
import { createHistoryFixture, type HistoryFixture } from "./history.testing"

let f: HistoryFixture
beforeEach(async () => {
  f = await createHistoryFixture()
  seedWorld(f)
})
afterEach(async () => {
  await f.dispose()
})

/** Messages 1 to 10 of `CHANNEL`, vouched from the first to the last; 11 and 12 are stored past that edge. */
function seedTen(complete = false) {
  storeMessages(f, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  vouch(f, CHANNEL, 1, 10, complete)
}

describe("what is selected", () => {
  test("the limits are 2000 by default and 10000 at most", () => {
    expect([EXPORT_LIMIT_DEFAULT, EXPORT_LIMIT_MAX]).toEqual([2000, 10000])
  })

  test("the vouched range, oldest first, with the chat and a link to each message", async () => {
    seedTen()
    const selection = await selectIn(f, { chat: CHANNEL })
    expect(numbersOf(selection)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(selection.chat).toEqual({
      id: CHANNEL,
      name: "#general",
      kind: "text",
      server: SERVER,
      server_name: "Test server",
    })
    expect(selection.messages[0]).toMatchObject({
      id: msgId(1),
      author: "user02",
      text: "text 001",
      permalink: `https://discord.com/channels/${SERVER}/${CHANNEL}/${msgId(1)}`,
    })
    expect(selection.truncated).toBe(false)
  })

  test("a private chat links to @me", async () => {
    storeMessages(f, [1, 2], DM)
    vouch(f, DM, 1, 2)
    const selection = await selectIn(f, { chat: DM })
    expect(selection.chat).toMatchObject({ id: DM, kind: "dm", server: null, server_name: null })
    expect(selection.messages[0]!.permalink).toBe(`https://discord.com/channels/@me/${DM}/${msgId(1)}`)
  })

  test("every type of message, system messages with their event", async () => {
    store(f, said(CHANNEL, 1), said(CHANNEL, 2, { type: 7, content: "" }), said(CHANNEL, 3, { type: 19 }))
    vouch(f, CHANNEL, 1, 3)
    const selection = await selectIn(f, { chat: CHANNEL })
    expect(selection.messages.map(({ type, event }) => [type, event])).toEqual([
      [0, null],
      [7, "joined"],
      [19, null],
    ])
  })

  test("messages stored below the oldest edge are not vouched for and stay out", async () => {
    storeMessages(f, [1, 2, 3, 4])
    vouch(f, CHANNEL, 2, 4)
    expect(numbersOf(await selectIn(f, { chat: CHANNEL }))).toEqual([2, 3, 4])
  })

  test("a complete history without an oldest edge reaches from the first message", async () => {
    storeMessages(f, [1, 2])
    f.seed((m) => setCursorEdges(m, CHANNEL, { newest: msgId(2), complete: true }))
    const selection = await selectIn(f, { chat: CHANNEL })
    expect(numbersOf(selection)).toEqual([1, 2])
    expect(selection.complete_to_start).toBe(true)
  })
})

describe("the bounds", () => {
  test("after and before are exclusive", async () => {
    seedTen()
    expect(numbersOf(await selectIn(f, { chat: CHANNEL, after: msgId(3), before: msgId(7) }))).toEqual([4, 5, 6])
  })

  test("bounds outside the vouched range are cut to it", async () => {
    seedTen()
    expect(numbersOf(await selectIn(f, { chat: CHANNEL, after: msgId(0), before: msgId(100) }))).toHaveLength(10)
    expect(numbersOf(await selectIn(f, { chat: CHANNEL, after: "0" }))).toHaveLength(10)
  })

  test("a bound at the vouched edge keeps the edge message out only for the exclusive side", async () => {
    seedTen()
    expect(numbersOf(await selectIn(f, { chat: CHANNEL, after: msgId(1) }))[0]).toBe(2)
    expect(numbersOf(await selectIn(f, { chat: CHANNEL, before: msgId(10) })).at(-1)).toBe(9)
    expect(numbersOf(await selectIn(f, { chat: CHANNEL, before: msgId(11) })).at(-1)).toBe(10)
  })

  test("a range with no mirrored message is refused, so no file is empty", async () => {
    storeMessages(f, [1, 2, 3, 8, 9, 10])
    vouch(f, CHANNEL, 1, 10)
    for (const range of [
      { after: msgId(3), before: msgId(8) },
      { after: msgId(10) },
      { before: msgId(1) },
      { after: msgId(20), before: msgId(30) },
      { after: msgId(5), before: msgId(5) },
    ]) {
      expect(await failure(selectIn(f, { chat: CHANNEL, ...range }))).toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("no messages"),
      })
    }
  })
})

describe("limit", () => {
  test("without after, the newest messages are kept and the rest is cut from the old side", async () => {
    seedTen()
    const selection = await selectIn(f, { chat: CHANNEL, limit: 3 })
    expect(numbersOf(selection)).toEqual([8, 9, 10])
    expect(selection.truncated).toBe(true)
  })

  test("with after, the first messages from there are kept and the rest is cut from the new side", async () => {
    seedTen()
    const selection = await selectIn(f, { chat: CHANNEL, after: msgId(2), limit: 3 })
    expect(numbersOf(selection)).toEqual([3, 4, 5])
    expect(selection.truncated).toBe(true)
  })

  test("exactly limit messages are not truncated", async () => {
    seedTen()
    for (const extra of [{}, { after: msgId(0) }]) {
      const selection = await selectIn(f, { chat: CHANNEL, limit: 10, ...extra })
      expect(selection).toMatchObject({ truncated: false })
      expect(selection.messages).toHaveLength(10)
    }
    expect((await selectIn(f, { chat: CHANNEL, limit: 1 })).messages).toHaveLength(1)
  })
})

describe("how far it reaches", () => {
  test("complete_to_start needs a complete cursor and nothing vouched below the first message", async () => {
    seedTen(true)
    expect((await selectIn(f, { chat: CHANNEL })).complete_to_start).toBe(true)
    expect((await selectIn(f, { chat: CHANNEL, before: msgId(5) })).complete_to_start).toBe(true)
    expect((await selectIn(f, { chat: CHANNEL, after: msgId(3) })).complete_to_start).toBe(false)
    expect((await selectIn(f, { chat: CHANNEL, limit: 4 })).complete_to_start).toBe(false)
  })

  test("complete_to_start is false while the history is incomplete", async () => {
    seedTen()
    expect((await selectIn(f, { chat: CHANNEL })).complete_to_start).toBe(false)
  })

  test("current is whether a sync run marked the chat lately, and an export is made either way", async () => {
    seedTen()
    expect((await selectIn(f, { chat: CHANNEL })).current).toBe(false)
    markSynced(f, STALE_AGO, CHANNEL)
    expect((await selectIn(f, { chat: CHANNEL })).current).toBe(false)
    markSynced(f, 0, CHANNEL)
    expect((await selectIn(f, { chat: CHANNEL })).current).toBe(true)
  })

  test("left_out counts the stored messages past the newest edge, up to before", async () => {
    seedTen()
    expect((await selectIn(f, { chat: CHANNEL })).left_out).toBe(2)
    expect((await selectIn(f, { chat: CHANNEL, before: msgId(12) })).left_out).toBe(1)
    expect((await selectIn(f, { chat: CHANNEL, before: msgId(11) })).left_out).toBe(0)
    expect((await selectIn(f, { chat: CHANNEL, before: msgId(5) })).left_out).toBe(0)
    expect((await selectIn(f, { chat: CHANNEL, after: msgId(2), limit: 2 })).left_out).toBe(2)
  })

  test("left_out counts nothing of another chat", async () => {
    seedTen()
    storeMessages(f, [20, 21], DM)
    expect((await selectIn(f, { chat: CHANNEL })).left_out).toBe(2)
  })
})

describe("continue", () => {
  test("a chat that is cut at the old end offers older, from the first message", async () => {
    seedTen(true)
    const { continue: next } = await selectIn(f, { chat: CHANNEL, limit: 4 })
    expect(next).toEqual({ older: { before: msgId(7) }, backfill_first: false, newer: null })
  })

  test("an incomplete history that reaches no further offers a backfill first", async () => {
    seedTen()
    const { continue: next } = await selectIn(f, { chat: CHANNEL })
    expect(next).toEqual({ older: null, backfill_first: true, newer: null })
  })

  test("a complete history to its start offers nothing at the old end", async () => {
    seedTen(true)
    expect((await selectIn(f, { chat: CHANNEL })).continue).toEqual({ older: null, backfill_first: false, newer: null })
  })

  test("after cuts the old end and limit the new one: older and newer both", async () => {
    seedTen()
    const { continue: next } = await selectIn(f, { chat: CHANNEL, after: msgId(2), limit: 3 })
    expect(next).toEqual({ older: { before: msgId(3) }, backfill_first: false, newer: { after: msgId(5) } })
  })

  test("after without a cut offers no newer", async () => {
    seedTen()
    const { continue: next } = await selectIn(f, { chat: CHANNEL, after: msgId(6), limit: 4 })
    expect(next.newer).toBeNull()
  })

  test("following the hints gives the pieces of the whole history", async () => {
    seedTen(true)
    const newest = await selectIn(f, { chat: CHANNEL, limit: 4 })
    const middle = await selectIn(f, { chat: CHANNEL, limit: 4, before: newest.continue.older!.before })
    const oldest = await selectIn(f, { chat: CHANNEL, limit: 4, before: middle.continue.older!.before })
    expect([numbersOf(newest), numbersOf(middle), numbersOf(oldest)]).toEqual([
      [7, 8, 9, 10],
      [3, 4, 5, 6],
      [1, 2],
    ])
    expect(oldest.continue.older).toBeNull()
    expect(oldest.complete_to_start).toBe(true)
  })
})

describe("what is refused", () => {
  test("a chat with no cursor, with no newest edge, or with no oldest edge while incomplete", async () => {
    storeMessages(f, [1, 2])
    for (const prepare of [
      () => {},
      () => markSynced(f, 0, CHANNEL),
      () => f.seed((m) => setCursorEdges(m, CHANNEL, { newest: msgId(2) })),
    ]) {
      prepare()
      expect(await failure(selectIn(f, { chat: CHANNEL }))).toMatchObject({
        code: "not_found",
        message: expect.stringContaining("discord_sync_add"),
      })
    }
  })

  test("says what makes each kind of chat exportable, and that a live read does not", async () => {
    const message = async (chat: string) => (await failure(selectIn(f, { chat }))).message
    const dm = await message(DM)
    expect(dm).toContain("every DM")
    expect(dm).toContain("next one")
    expect(dm).not.toContain("discord_sync_add")
    const channel = await message(CHANNEL)
    expect(channel).toContain("discord_sync_read")
    expect(channel).toContain("discord_sync_add")
    expect(channel).toContain("next sync run")
    for (const text of [dm, channel]) {
      expect(text).toContain("does not make it exportable")
      expect(text).not.toContain("backfill")
    }
    const thread = await message(THREAD)
    expect(thread).toContain("cannot be exported")
    expect(thread).not.toContain("discord_sync_add")
  })

  test("a chat the mirror does not know", async () => {
    expect(await failure(selectIn(f, { chat: "1400000000000000999" }))).toMatchObject({ code: "not_found" })
  })

  test("a forum and a category", async () => {
    for (const chat of [FORUM, CATEGORY]) {
      expect(await failure(selectIn(f, { chat }))).toMatchObject({ code: "invalid_argument" })
    }
  })
})
