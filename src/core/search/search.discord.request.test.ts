import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, CHANNEL, DM, msgId, SERVER } from "../discord/objects.testing"
import { snowflakeAt } from "../discord/snowflake"
import {
  answer,
  chatSearch,
  GUILD_SEARCH,
  queryOf,
  refererOf,
  searchDiscord,
  sentTo,
  TABS_SEARCH,
  tabsAnswer,
} from "./search.discord.testing"
import { createSearchFixture, seedWorld, THREAD, type SearchFixture } from "./search.testing"

let f: SearchFixture
beforeEach(async () => {
  f = await createSearchFixture()
  seedWorld(f)
  f.discord.route("GET", GUILD_SEARCH, answer([]))
  f.discord.route("GET", chatSearch(DM), answer([]))
  f.discord.route("POST", TABS_SEARCH, tabsAnswer([]))
})
afterEach(async () => {
  await f.dispose()
})

const everything = {
  query: "hello there",
  author: ALICE,
  mentions: BOB,
  has: ["link", "image"],
  pinned: true,
  before: msgId(500),
  after: msgId(10),
  limit: 10,
}

describe("a search of a server", () => {
  test("asks the server's search with every term, a repeated key for each list element", async () => {
    await searchDiscord(f, { server: SERVER, ...everything })
    expect(f.discord.api).toHaveLength(1)
    const [request] = sentTo(f, GUILD_SEARCH)
    expect(request!.method).toBe("GET")
    expect(refererOf(request!)).toBe(`/channels/${SERVER}`)
    expect(queryOf(request!)).toEqual({
      content: ["hello there"],
      author_id: [ALICE],
      mentions: [BOB],
      has: ["link", "image"],
      pinned: ["true"],
      max_id: [msgId(500)],
      min_id: [msgId(10)],
      limit: ["10"],
      sort_by: ["timestamp"],
      sort_order: ["desc"],
      include_nsfw: ["true"],
    })
  })

  test("leaves out every term the arguments do not give, and asks for 25 by default", async () => {
    await searchDiscord(f, { server: SERVER, query: undefined, pinned: false })
    expect(queryOf(sentTo(f, GUILD_SEARCH)[0]!)).toEqual({
      pinned: ["false"],
      limit: ["25"],
      sort_by: ["timestamp"],
      sort_order: ["desc"],
      include_nsfw: ["true"],
    })
  })

  test("a chat of the server adds its id and comes from that chat's page", async () => {
    await searchDiscord(f, { channel: CHANNEL })
    const [request] = sentTo(f, GUILD_SEARCH)
    expect(queryOf(request!).channel_id).toEqual([CHANNEL])
    expect(refererOf(request!)).toBe(`/channels/${SERVER}/${CHANNEL}`)
  })

  test("a thread is a chat of its server", async () => {
    await searchDiscord(f, { channel: THREAD })
    const [request] = sentTo(f, GUILD_SEARCH)
    expect(queryOf(request!).channel_id).toEqual([THREAD])
    expect(refererOf(request!)).toBe(`/channels/${SERVER}/${THREAD}`)
  })
})

describe("a search of a DM", () => {
  test("asks the DM's own search, without a server's terms", async () => {
    await searchDiscord(f, { channel: DM, author: ALICE, has: ["file"] })
    const [request] = sentTo(f, chatSearch(DM))
    expect(request!.method).toBe("GET")
    expect(refererOf(request!)).toBe(`/channels/@me/${DM}`)
    expect(queryOf(request!)).toEqual({
      content: ["text"],
      author_id: [ALICE],
      has: ["file"],
      limit: ["25"],
      sort_by: ["timestamp"],
      sort_order: ["desc"],
    })
  })
})

describe("a search of every DM", () => {
  test("posts the terms to the tabs search, lists staying lists", async () => {
    await searchDiscord(f, everything)
    expect(f.discord.api).toHaveLength(1)
    const [request] = sentTo(f, TABS_SEARCH)
    expect(request!.method).toBe("POST")
    expect(refererOf(request!)).toBe("/channels/@me")
    expect(request!.url.endsWith(TABS_SEARCH)).toBe(true)
    expect(JSON.parse(request!.body!)).toEqual({
      tabs: {
        messages: {
          content: "hello there",
          author_id: [ALICE],
          mentions: [BOB],
          has: ["link", "image"],
          pinned: true,
          max_id: msgId(500),
          min_id: msgId(10),
          limit: 10,
          sort_by: "timestamp",
          sort_order: "desc",
          cursor: null,
        },
      },
      track_exact_total_hits: false,
    })
  })

  test("sends only the terms given, and no include_nsfw", async () => {
    await searchDiscord(f, { query: undefined, author: ALICE })
    expect(JSON.parse(sentTo(f, TABS_SEARCH)[0]!.body!)).toEqual({
      tabs: {
        messages: {
          author_id: [ALICE],
          limit: 25,
          sort_by: "timestamp",
          sort_order: "desc",
          cursor: null,
        },
      },
      track_exact_total_hits: false,
    })
  })
})

describe("the bounds", () => {
  test("a date is the id of its instant: before keeps what came before it, after what came at or after", async () => {
    await searchDiscord(f, { server: SERVER, before: "2026-03-01", after: "2026-02-01" })
    const query = queryOf(sentTo(f, GUILD_SEARCH)[0]!)
    expect(query.max_id).toEqual([snowflakeAt(Date.parse("2026-03-01T00:00:00Z"))])
    expect(query.min_id).toEqual([String(BigInt(snowflakeAt(Date.parse("2026-02-01T00:00:00Z"))) - 1n)])
  })

  test("an after before Discord's first id is no lower bound", async () => {
    await searchDiscord(f, { server: SERVER, after: "2010-01-01" })
    expect(queryOf(sentTo(f, GUILD_SEARCH)[0]!)).not.toHaveProperty("min_id")
  })

  test("no search offsets", async () => {
    await searchDiscord(f, { server: SERVER, ...everything })
    await searchDiscord(f, { channel: DM, ...everything })
    await searchDiscord(f, everything)
    for (const request of f.discord.api) {
      expect(request.url).not.toContain("offset")
      expect(request.body ?? "").not.toContain("offset")
    }
  })
})
