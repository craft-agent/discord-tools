import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { columnOf } from "../discord/mirror.testing"
import { CHANNEL, DM, SERVER } from "../discord/objects.testing"
import {
  answer,
  chatSearch,
  found,
  GUILD_SEARCH,
  searchDiscord,
  sentTo,
  TABS_SEARCH,
  tabsAnswer,
} from "./search.discord.testing"
import { createSearchFixture, seedWorld, type SearchFixture } from "./search.testing"

let f: SearchFixture
beforeEach(async () => {
  f = await createSearchFixture()
  seedWorld(f)
})
afterEach(async () => {
  await f.dispose()
})

const stored = () => f.inspect((m) => columnOf(m, "SELECT id FROM messages"))
const hit = [[found(CHANNEL, 1)]]

describe("Discord's answer", () => {
  test.each([
    ["not an object", { status: 200, json: [hit] }],
    ["no messages", { status: 200, json: { total_results: 1 } }],
    ["messages that are no list", { status: 200, json: { messages: "x", total_results: 1 } }],
    ["a group that is no list", { status: 200, json: { messages: [found(CHANNEL, 1)], total_results: 1 } }],
    ["a total that is no number", { status: 200, json: { messages: hit, total_results: "1" } }],
    ["a negative total", { status: 200, json: { messages: hit, total_results: -1 } }],
    ["a total that is no integer", { status: 200, json: { messages: hit, total_results: 1.5 } }],
    ["threads that are no list", { status: 200, json: { messages: hit, total_results: 1, threads: {} } }],
  ])("%s is an upstream error and stores nothing", async (_name, malformed) => {
    f.discord.route("GET", GUILD_SEARCH, malformed)
    expect((await failure(searchDiscord(f, { server: SERVER }))).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test.each([
    ["no tabs", { status: 200, json: { messages: hit, total_results: 1 } }],
    ["no messages tab", { status: 200, json: { tabs: {} } }],
    [
      "a tab with a total that is no number",
      { status: 200, json: { tabs: { messages: { messages: hit, total_results: "1" } } } },
    ],
    ["a tab that is no object", { status: 200, json: { tabs: { messages: [hit] } } }],
  ])("the search of every DM: %s is an upstream error and stores nothing", async (_name, malformed) => {
    f.discord.route("POST", TABS_SEARCH, malformed)
    expect((await failure(searchDiscord(f))).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test("an answer without JSON is an upstream error", async () => {
    f.discord.route("GET", chatSearch(DM), { status: 200, text: "<html>" })
    expect((await failure(searchDiscord(f, { channel: DM }))).code).toBe("upstream_error")
  })
})

describe("Discord's refusals", () => {
  test("403 is forbidden and 404 not found, and nothing is stored", async () => {
    f.discord.route("GET", GUILD_SEARCH, { status: 403, json: { code: 50001, message: "Missing Access" } })
    expect((await failure(searchDiscord(f, { server: SERVER }))).code).toBe("forbidden")
    f.discord.route("GET", chatSearch(DM), { status: 404, json: { code: 10003, message: "Unknown Channel" } })
    expect((await failure(searchDiscord(f, { channel: DM }))).code).toBe("not_found")
    f.discord.route("POST", TABS_SEARCH, { status: 403, json: { code: 50001, message: "Missing Access" } })
    expect((await failure(searchDiscord(f))).code).toBe("forbidden")
    expect(stored()).toEqual([])
  })
})

describe("a search index still being built", () => {
  const indexing = { status: 202, json: { code: 110000, message: "Index not yet available.", retry_after: 4 } }

  test("is waited out once, and then the search succeeds", async () => {
    f.discord.route("GET", GUILD_SEARCH, [indexing, answer(hit)])
    const result = await searchDiscord(f, { server: SERVER })
    expect(result.messages).toHaveLength(1)
    expect(sentTo(f, GUILD_SEARCH)).toHaveLength(2)
    expect(f.sleeps).toContain(4500)
  })

  test("is waited out for the search of every DM too", async () => {
    f.discord.route("POST", TABS_SEARCH, [indexing, tabsAnswer(hit)])
    expect((await searchDiscord(f)).messages).toHaveLength(1)
    expect(sentTo(f, TABS_SEARCH)).toHaveLength(2)
  })

  test("is rate_limited when it is still being built after the wait, storing nothing", async () => {
    f.discord.route("GET", GUILD_SEARCH, indexing)
    const error = await failure(searchDiscord(f, { server: SERVER }))
    expect(error.code).toBe("rate_limited")
    expect(sentTo(f, GUILD_SEARCH)).toHaveLength(2)
    expect(stored()).toEqual([])
  })
})
