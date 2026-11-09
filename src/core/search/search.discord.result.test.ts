import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { columnOf, rowById, rowsOf } from "../discord/mirror.testing"
import { channelObject, CHANNEL, DM, msgId, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import {
  answer,
  chatSearch,
  found,
  GUILD_SEARCH,
  searchDiscord,
  TABS_SEARCH,
  tabsAnswer,
} from "./search.discord.testing"
import {
  createSearchFixture,
  markSynced,
  numbersOf,
  OTHER_SERVER,
  said,
  seedWorld,
  store,
  THREAD,
  type SearchFixture,
} from "./search.testing"

let f: SearchFixture
beforeEach(async () => {
  f = await createSearchFixture()
  seedWorld(f)
})
afterEach(async () => {
  await f.dispose()
})

const serve = (...groups: unknown[]) => f.discord.route("GET", GUILD_SEARCH, answer(groups))
const stored = () => f.inspect((m) => columnOf(m, "SELECT CAST(id AS TEXT) FROM messages ORDER BY id"))
const cursors = () =>
  f.inspect((m) => rowsOf(m, "SELECT CAST(channel AS TEXT) AS channel, complete, synced_at FROM cursors"))

describe("the hits of a group", () => {
  test("are the marked messages, else the first one; context, junk and repeats are dropped, Discord's order kept", async () => {
    serve(
      [said(CHANNEL, 4), found(CHANNEL, 5), said(CHANNEL, 6)],
      [said(CHANNEL, 3), said(CHANNEL, 2)],
      ["junk", null, said(CHANNEL, 1)],
      [found(CHANNEL, 5)],
      [{ id: "not an id", hit: true }, 7],
    )
    const result = await searchDiscord(f, { server: SERVER })
    expect(numbersOf(result)).toEqual([5, 3, 1])
    expect(stored()).toEqual([msgId(1), msgId(3), msgId(5)])
  })

  test("a message is the item `mirror` gives for it", async () => {
    serve([found(CHANNEL, 2, { content: "link https://example.test" })], [found(OTHER_CHANNEL, 1)])
    const result = await searchDiscord(f, { server: SERVER })
    expect(result).toMatchObject({ method: "discord", source: "discord", total: 2 })
    expect(result.note).toContain("Discord's own search found these")
    expect(result.note).toContain(UNTRUSTED_NOTE)
    const mirrored = await f.search({ method: "mirror", server: SERVER, query: "t" })
    expect(mirrored.messages).toEqual(result.messages)
    expect(result.messages[0]).toMatchObject({ channel: CHANNEL, server: SERVER, author: "user02" })
  })
})

describe("the hits are stored", () => {
  test("without a range, a cursor or a current mark, and with stored reactions kept", async () => {
    const reaction = { emoji: { name: "👍" }, count: 3, me: false }
    store(f, said(CHANNEL, 5, { reactions: [reaction] }), said(CHANNEL, 4))
    markSynced(f, 1000, CHANNEL)
    const before = cursors()
    serve([found(CHANNEL, 5, { content: "edited text" })], [found(CHANNEL, 9)])
    const result = await searchDiscord(f, { channel: CHANNEL })
    expect(stored()).toEqual([msgId(4), msgId(5), msgId(9)])
    expect(result.messages[0]).toMatchObject({ text: "edited text", reactions: [{ emoji: "👍", count: 3, me: false }] })
    expect(result.reactions_note).toBeString()
    expect(cursors()).toEqual(before)
  })

  test("a chat no sync run marked is not current", async () => {
    serve([found(CHANNEL, 1)])
    const result = await searchDiscord(f, { channel: CHANNEL })
    expect(result.chats).toEqual([{ id: CHANNEL, name: "general", server: SERVER, synced_at: null, current: false }])
    expect(cursors()).toEqual([])
    expect(result).not.toHaveProperty("reactions_note")
  })

  test("a hit in a chat the mirror does not know is in the searched server", async () => {
    const unknown = "1400000000000000777"
    serve([found(unknown, 1)])
    const result = await searchDiscord(f, { server: SERVER })
    expect(result.messages[0]).toMatchObject({ channel: unknown, server: SERVER })
    expect(result.chats).toMatchObject([{ id: unknown, name: null, server: SERVER }])
  })

  test("the threads of a server search are stored, and only threads of that server", async () => {
    const newThread = "1400000000000000501"
    f.discord.route(
      "GET",
      GUILD_SEARCH,
      answer([[found(newThread, 3)], [found(CHANNEL, 2)]], {
        threads: [
          channelObject(newThread, { type: 11, name: "fresh thread", parent_id: CHANNEL, guild_id: SERVER }),
          channelObject(OTHER_CHANNEL, { name: "hijacked" }),
          channelObject(THREAD, { type: 11, name: "elsewhere", guild_id: OTHER_SERVER }),
          "junk",
        ],
      }),
    )
    const result = await searchDiscord(f, { server: SERVER })
    expect(result.chats.map((chat) => [chat.id, chat.name, chat.server])).toEqual([
      [newThread, "fresh thread", SERVER],
      [CHANNEL, "general", SERVER],
    ])
    expect(f.inspect((m) => rowById(m, "channels", newThread))).toMatchObject({ name: "fresh thread" })
    expect(f.inspect((m) => rowById(m, "channels", OTHER_CHANNEL))).toMatchObject({ name: "random" })
    expect(f.inspect((m) => rowById(m, "channels", THREAD))).toMatchObject({ name: "a thread" })
  })

  test("the search of every DM stores its hits and none of the channels it describes", async () => {
    const stranger = "1400000000000000888"
    f.discord.route(
      "POST",
      TABS_SEARCH,
      tabsAnswer([[found(DM, 4)], [found(stranger, 3)]], { channels: [channelObject(stranger, { type: 1 })] }),
    )
    const result = await searchDiscord(f)
    expect(numbersOf(result)).toEqual([4, 3])
    expect(result.chats).toMatchObject([
      { id: DM, name: null, server: null },
      { id: stranger, name: null, server: null },
    ])
    expect(f.inspect((m) => rowById(m, "channels", stranger))).toBeUndefined()
  })
})

describe("paging", () => {
  test("a short page with messages still gives next_before, the oldest id, and Discord's total", async () => {
    f.discord.route("GET", GUILD_SEARCH, answer([[found(CHANNEL, 9)], [found(CHANNEL, 7)]], { total_results: 120 }))
    const result = await searchDiscord(f, { server: SERVER, limit: 20 })
    expect(result).toMatchObject({ total: 120, next_before: msgId(7) })
  })

  test("a page of one chat or of every DM pages the same way", async () => {
    f.discord.route("GET", chatSearch(DM), answer([[found(DM, 6)], [found(DM, 2)]]))
    expect((await searchDiscord(f, { channel: DM })).next_before).toBe(msgId(2))
    f.discord.route("POST", TABS_SEARCH, tabsAnswer([[found(DM, 8)]], { total_results: 31 }))
    expect(await searchDiscord(f)).toMatchObject({ total: 31, next_before: msgId(8) })
  })

  test("an empty page has no next_before and keeps the total", async () => {
    f.discord.route("GET", GUILD_SEARCH, answer([], { total_results: 40 }))
    const result = await searchDiscord(f, { server: SERVER })
    expect(result).toMatchObject({ messages: [], chats: [], total: 40 })
    expect(result).not.toHaveProperty("next_before")
  })

  test("a page of the next older messages is asked with before = next_before", async () => {
    serve([found(CHANNEL, 9)], [found(CHANNEL, 7)])
    const first = await searchDiscord(f, { server: SERVER })
    serve([found(CHANNEL, 5)])
    await searchDiscord(f, { server: SERVER, before: first.next_before })
    expect(f.discord.api.at(-1)!.query.get("max_id")).toBe(msgId(7))
  })

  test("hits at or after `before` are dropped, so an answer that ignores it ends the paging", async () => {
    serve([found(CHANNEL, 9)], [found(CHANNEL, 7)], [found(CHANNEL, 5)])
    const partly = await searchDiscord(f, { server: SERVER, before: msgId(7) })
    expect(numbersOf(partly)).toEqual([5])
    expect(partly.next_before).toBe(msgId(5))
    const repeated = await searchDiscord(f, { server: SERVER, before: msgId(5) })
    expect(repeated.messages).toEqual([])
    expect(repeated).not.toHaveProperty("next_before")
  })

  test("a page whose hits the mirror could not store still moves back", async () => {
    serve([found(CHANNEL, 6, { channel_id: undefined })], [found(CHANNEL, 4, { channel_id: undefined })])
    const result = await searchDiscord(f, { server: SERVER })
    expect(result.messages).toEqual([])
    expect(result.next_before).toBe(msgId(4))
  })

  test("an answer without a total gives none", async () => {
    f.discord.route("GET", GUILD_SEARCH, { status: 200, json: { messages: [[found(CHANNEL, 3)]] } })
    const result = await searchDiscord(f, { server: SERVER })
    expect(result).not.toHaveProperty("total")
    expect(result.next_before).toBe(msgId(3))
  })
})
