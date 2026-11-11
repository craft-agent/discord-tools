import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ALICE, BOB, CHANNEL, DM, ME, OTHER_CHANNEL, SERVER, userObject } from "../discord/objects.testing"
import { FAR_CHANNEL, OTHER_SERVER, seedWorld, store } from "../search/search.testing"
import { createHistoryFixture, DAY_MS, type HistoryFixture, sentAt, sentByMe } from "./history.testing"

let f: HistoryFixture
beforeEach(async () => {
  f = await createHistoryFixture()
  seedWorld(f)
})
afterEach(async () => {
  await f.dispose()
})

/** The instant `days` days before the fixture's clock, in milliseconds. */
const ago = (days: number) => f.now() - days * DAY_MS

/** The ISO 8601 UTC time of an instant in milliseconds. */
const iso = (time: number) => new Date(time).toISOString()

describe("by chat", () => {
  beforeEach(() => {
    store(
      f,
      sentAt(CHANNEL, ago(1)),
      sentAt(CHANNEL, ago(1), 1, { author: userObject(BOB) }),
      sentByMe(CHANNEL, ago(2)),
      sentAt(OTHER_CHANNEL, ago(3)),
      sentAt(DM, ago(5)),
      sentAt(DM, ago(4), 0, { author: userObject(BOB) }),
    )
  })

  test("counts each chat of the past 30 days, the one with the most messages first, and says what it is", async () => {
    const result = await f.counts()
    expect(result).toMatchObject({
      method: "counts",
      source: "mirror",
      by: "chat",
      window_start: iso(ago(30)),
      window_end: null,
      total: 6,
      from_me: 1,
      from_others: 5,
      people: 3,
      chats: 3,
      more: false,
    })
    expect(result.note).toContain("local mirror alone")
    expect(result.note).toContain(UNTRUSTED_NOTE)
    expect(result.by_chat).toEqual([
      {
        chat: { id: CHANNEL, name: "#general", kind: "text", server: SERVER, server_name: "Test server" },
        messages: 3,
        from_me: 1,
        people: 3,
        first: iso(ago(2)),
        last: iso(ago(1)),
        partial: true,
        current: false,
      },
      {
        chat: { id: DM, name: "user02", kind: "dm", server: null, server_name: null },
        messages: 2,
        from_me: 0,
        people: 2,
        first: iso(ago(5)),
        last: iso(ago(4)),
        partial: true,
        current: false,
      },
      {
        chat: { id: OTHER_CHANNEL, name: "#random", kind: "text", server: SERVER, server_name: "Test server" },
        messages: 1,
        from_me: 0,
        people: 1,
        first: iso(ago(3)),
        last: iso(ago(3)),
        partial: true,
        current: false,
      },
    ])
    expect(result.by_author).toBeUndefined()
    expect(result.by_day).toBeUndefined()
  })

  test("is the default, makes no request and reads no text", async () => {
    expect(await f.counts({ by: "chat" })).toEqual(await f.counts())
    expect(JSON.stringify(await f.counts())).not.toContain("text 0")
    expect(f.discord.requests).toEqual([])
  })

  test("orders chats with as many messages by the most recent", async () => {
    store(f, sentAt(OTHER_CHANNEL, ago(0.5)))
    expect((await f.counts()).by_chat?.map(({ chat }) => chat.id)).toEqual([CHANNEL, OTHER_CHANNEL, DM])
    store(f, sentAt(DM, ago(0.2)))
    expect((await f.counts()).by_chat?.map(({ chat }) => chat.id)).toEqual([DM, CHANNEL, OTHER_CHANNEL])
  })

  test("cuts the rows at limit and keeps the totals of the whole window", async () => {
    const cut = await f.counts({ limit: 2 })
    expect(cut.by_chat?.map(({ chat }) => chat.id)).toEqual([CHANNEL, DM])
    expect(cut).toMatchObject({ more: true, total: 6, from_me: 1, from_others: 5, people: 3, chats: 3 })
    expect(cut.coverage).toEqual({ partial: 3, not_current: 3 })
    expect(await f.counts({ limit: 3 })).toMatchObject({ more: false })
  })

  test("counts ordinary messages and replies, not system messages or messages outside the window", async () => {
    store(
      f,
      sentAt(OTHER_CHANNEL, ago(1), 10, { type: 7 }),
      sentAt(OTHER_CHANNEL, ago(1), 11, { type: 6 }),
      sentAt(OTHER_CHANNEL, ago(1), 12, { type: 46 }),
      sentAt(OTHER_CHANNEL, ago(31)),
      sentAt(FAR_CHANNEL, ago(1), 13, { type: 3 }),
    )
    expect(await f.counts()).toMatchObject({ total: 6, chats: 3 })
    store(f, sentAt(OTHER_CHANNEL, ago(1), 14, { type: 19 }))
    const result = await f.counts()
    expect(result).toMatchObject({ total: 7, chats: 3 })
    expect(result.by_chat?.find(({ chat }) => chat.id === OTHER_CHANNEL)).toMatchObject({ messages: 2 })
  })

  test("is empty when the window holds nothing", async () => {
    expect(await f.counts({ after: iso(ago(0)) })).toMatchObject({
      by_chat: [],
      total: 0,
      from_me: 0,
      from_others: 0,
      people: 0,
      chats: 0,
      coverage: { partial: 0, not_current: 0 },
      more: false,
    })
  })
})

describe("the window", () => {
  const MARCH_1 = "2026-03-01T10:00:00Z"
  const MARCH_2 = "2026-03-02T10:00:00Z"
  const MARCH_3 = "2026-03-03T10:00:00Z"
  beforeEach(() => {
    store(f, sentAt(CHANNEL, MARCH_1), sentAt(CHANNEL, MARCH_2), sentAt(CHANNEL, MARCH_3))
  })

  const totalOf = async (args: Record<string, unknown>) => (await f.counts(args)).total

  test("takes a date as UTC midnight, and names the window", async () => {
    const result = await f.counts({ after: "2026-03-02", before: "2026-03-03" })
    expect(result).toMatchObject({
      total: 1,
      window_start: "2026-03-02T00:00:00.000Z",
      window_end: "2026-03-03T00:00:00.000Z",
    })
  })

  test("takes a timestamp with a zone; after includes its instant and before leaves it out", async () => {
    expect(await totalOf({ after: "2026-03-02T19:00:00+09:00" })).toBe(2)
    expect(await totalOf({ after: "2026-03-02T10:00:00.001Z" })).toBe(1)
    expect(await totalOf({ before: "2026-03-02T19:00:00+09:00", after: "2026-03-01" })).toBe(1)
    expect(await totalOf({ before: "2026-03-02T10:00:00.001Z", after: "2026-03-01" })).toBe(2)
  })

  test("takes message ids, both bounds exclusive", async () => {
    const [first, second, third] = f.inspect((m) =>
      (m.prepare("SELECT CAST(id AS TEXT) AS id FROM messages ORDER BY id").all() as { id: string }[]).map(
        ({ id }) => id,
      ),
    )
    expect(await totalOf({ after: first })).toBe(2)
    expect(await totalOf({ after: first, before: third })).toBe(1)
    expect(await totalOf({ before: second, after: "2026-03-01" })).toBe(1)
    expect(await f.counts({ after: first, before: third })).toMatchObject({ window_end: iso(Date.parse(MARCH_3)) })
  })

  test("a before older than the default start needs an after", async () => {
    expect((await failure(f.counts({ before: "2020-01-01" }))).code).toBe("invalid_argument")
    expect(await totalOf({ before: "2026-03-02" })).toBe(1)
  })
})

describe("server and chat", () => {
  beforeEach(() => {
    store(
      f,
      sentAt(CHANNEL, ago(1)),
      sentAt(OTHER_CHANNEL, ago(1), 1),
      sentAt(FAR_CHANNEL, ago(1), 2),
      sentAt(DM, ago(1), 3),
    )
  })

  test("a server counts only its chats", async () => {
    const result = await f.counts({ server: SERVER })
    expect(result.by_chat?.map(({ chat }) => chat.id).sort()).toEqual([CHANNEL, OTHER_CHANNEL])
    expect(result).toMatchObject({ total: 2, chats: 2 })
    const other = await f.counts({ server: OTHER_SERVER })
    expect(other.by_chat).toMatchObject([{ chat: { id: FAR_CHANNEL, server: OTHER_SERVER } }])
  })

  test("a chat counts only itself", async () => {
    const result = await f.counts({ chat: DM })
    expect(result).toMatchObject({ total: 1, chats: 1, by_chat: [{ chat: { id: DM } }] })
  })

  test("a chat outside the server counts nothing", async () => {
    expect(await f.counts({ server: OTHER_SERVER, chat: CHANNEL })).toMatchObject({ total: 0, by_chat: [] })
  })

  test("a server or chat the mirror does not know is not_found", async () => {
    expect((await failure(f.counts({ server: "1400000000000000999" }))).code).toBe("not_found")
    expect((await failure(f.counts({ chat: "1400000000000000999" }))).code).toBe("not_found")
  })
})

describe("by author", () => {
  beforeEach(() => {
    store(
      f,
      sentAt(CHANNEL, ago(6), 0, { member: { nick: "Al" } }),
      sentAt(CHANNEL, ago(2), 0, { member: { nick: "Alice in General" } }),
      sentAt(DM, ago(1)),
      sentAt(CHANNEL, ago(5), 0, { author: userObject(BOB), member: { nick: "Bobby" } }),
      sentAt(CHANNEL, ago(4), 0, { author: userObject(BOB) }),
      sentByMe(CHANNEL, ago(3)),
      sentAt(OTHER_CHANNEL, ago(3), 1, { author: userObject("1400000000000000004", { global_name: "Carol C" }) }),
    )
  })

  test("counts each author, the one with the most messages first, and names them", async () => {
    const result = await f.counts({ by: "author" })
    expect(result).toMatchObject({
      by: "author",
      total: 7,
      from_me: 1,
      from_others: 6,
      people: 4,
      chats: 3,
      more: false,
    })
    expect(result.by_author).toEqual([
      { author_id: ALICE, author: "user02", messages: 3, chats: 2, last: iso(ago(1)) },
      { author_id: BOB, author: "user03", messages: 2, chats: 1, last: iso(ago(4)) },
      { author_id: "1400000000000000004", author: "Carol C", messages: 1, chats: 1, last: iso(ago(3)) },
      { author_id: ME, author: "user01", messages: 1, chats: 1, last: iso(ago(3)) },
    ])
    expect(result.by_chat).toBeUndefined()
  })

  test("names an author by the nickname of their latest counted message", async () => {
    const result = await f.counts({ by: "author", chat: CHANNEL })
    expect(result.by_author?.find(({ author_id }) => author_id === ALICE)).toMatchObject({
      author: "Alice in General",
      messages: 2,
      chats: 1,
    })
    expect(result.by_author?.find(({ author_id }) => author_id === BOB)).toMatchObject({ author: "user03" })
  })

  test("cuts the rows at limit and keeps the totals of the whole window", async () => {
    const result = await f.counts({ by: "author", limit: 2 })
    expect(result.by_author?.map(({ author_id }) => author_id)).toEqual([ALICE, BOB])
    expect(result).toMatchObject({ more: true, total: 7, people: 4 })
    expect(await f.counts({ by: "author", limit: 4 })).toMatchObject({ more: false })
  })

  test("is empty when no one wrote in the window", async () => {
    expect(await f.counts({ by: "author", after: "2030-01-01" })).toMatchObject({ by_author: [], total: 0 })
  })
})
