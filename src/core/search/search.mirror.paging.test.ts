import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, DM, msgId, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import {
  createSearchFixture,
  markSynced,
  numbersOf,
  said,
  seedWorld,
  STALE_AGO,
  store,
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

const search = (args: Record<string, unknown> = {}) => f.search({ method: "mirror", query: "text", ...args })

describe("order, bounds and pages", () => {
  test("messages come newest first across chats", async () => {
    store(f, said(CHANNEL, 1), said(OTHER_CHANNEL, 2), said(CHANNEL, 3), said(OTHER_CHANNEL, 4), said(CHANNEL, 5))
    expect(numbersOf(await search())).toEqual([5, 4, 3, 2, 1])
  })

  test("before and after are exclusive ids, and dates work too", async () => {
    store(f, said(CHANNEL, 1), said(CHANNEL, 2), said(CHANNEL, 3), said(CHANNEL, 4), said(CHANNEL, 5))
    expect(numbersOf(await search({ before: msgId(4), after: msgId(1) }))).toEqual([3, 2])
    expect(numbersOf(await search({ before: msgId(3) }))).toEqual([2, 1])
    expect(numbersOf(await search({ after: msgId(3) }))).toEqual([5, 4])
    expect(numbersOf(await search({ before: "2030-01-01" }))).toEqual([5, 4, 3, 2, 1])
    expect(numbersOf(await search({ after: "2030-01-01" }))).toEqual([])
  })

  test("a bound that is not an id, a date or a timestamp, or is out of order, is refused", async () => {
    expect((await failure(search({ before: "yesterday" }))).code).toBe("invalid_argument")
    expect((await failure(search({ before: msgId(2), after: msgId(3) }))).code).toBe("invalid_argument")
  })

  test("the limit defaults to 25, and next_before appears only on a full page", async () => {
    store(f, ...Array.from({ length: 30 }, (_, i) => said(CHANNEL, i + 1)))
    const page = await search()
    expect(page.messages).toHaveLength(25)
    expect(page.next_before).toBe(msgId(6))
    const last = await search({ before: page.next_before })
    expect(numbersOf(last)).toEqual([5, 4, 3, 2, 1])
    expect(last).not.toHaveProperty("next_before")
  })

  test("a page that is exactly full still offers next_before, and the next one is empty", async () => {
    store(f, said(CHANNEL, 1), said(CHANNEL, 2))
    const page = await search({ limit: 2 })
    expect(page.next_before).toBe(msgId(1))
    expect((await search({ limit: 2, before: page.next_before })).messages).toEqual([])
  })

  test("paging with next_before continues without overlap and ends on a short page", async () => {
    store(f, ...Array.from({ length: 7 }, (_, i) => said(i % 2 === 0 ? CHANNEL : OTHER_CHANNEL, i + 1)))
    const seen: number[] = []
    let before: string | undefined
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await search({ limit: 3, ...(before ? { before } : {}) })
      seen.push(...numbersOf(page))
      if (page.next_before === undefined) break
      expect(page.messages).toHaveLength(3)
      before = page.next_before
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1])
  })

  test("a short page has no next_before, and the limit's maximum is 100", async () => {
    store(f, said(CHANNEL, 1), said(CHANNEL, 2))
    const short = await search({ limit: 3 })
    expect(short.messages).toHaveLength(2)
    expect(short).not.toHaveProperty("next_before")
    expect(await search({ limit: 100 })).toBeDefined()
    expect((await failure(search({ limit: 101 }))).code).toBe("invalid_argument")
  })
})

describe("the chats of a result", () => {
  test("each chat is listed once in the order it first appears, with its freshness", async () => {
    store(f, said(OTHER_CHANNEL, 9), said(CHANNEL, 7), said(DM, 5), said(OTHER_CHANNEL, 3), said(CHANNEL, 1))
    markSynced(f, 1000, CHANNEL)
    markSynced(f, STALE_AGO, OTHER_CHANNEL)
    const result = await search()
    expect(numbersOf(result)).toEqual([9, 7, 5, 3, 1])
    expect(result.chats).toEqual([
      {
        id: OTHER_CHANNEL,
        name: "random",
        server: SERVER,
        synced_at: new Date(f.now() - STALE_AGO).toISOString(),
        current: false,
      },
      {
        id: CHANNEL,
        name: "general",
        server: SERVER,
        synced_at: new Date(f.now() - 1000).toISOString(),
        current: true,
      },
      { id: DM, name: null, server: null, synced_at: null, current: false },
    ])
  })

  test("a stale chat is searched, and so is a chat no sync run ever followed", async () => {
    store(f, said(CHANNEL, 1), said(OTHER_CHANNEL, 2))
    markSynced(f, STALE_AGO, CHANNEL)
    const result = await search()
    expect(numbersOf(result)).toEqual([2, 1])
    expect(result.chats.map((chat) => [chat.id, chat.current])).toEqual([
      [OTHER_CHANNEL, false],
      [CHANNEL, false],
    ])
  })

  test("a chat is current for just under 15 minutes after the mark", async () => {
    store(f, said(CHANNEL, 1))
    markSynced(f, 14 * 60_000, CHANNEL)
    expect((await search()).chats[0]!.current).toBe(true)
    f.advance(2 * 60_000)
    expect((await search()).chats[0]!.current).toBe(false)
  })

  test("only the chats of the returned page are listed", async () => {
    store(f, said(OTHER_CHANNEL, 1), said(CHANNEL, 2))
    const result = await search({ limit: 1 })
    expect(result.chats.map((chat) => chat.id)).toEqual([CHANNEL])
  })

  test("a result with reactions carries the note about their counts", async () => {
    store(f, said(CHANNEL, 1, { reactions: [{ emoji: { name: "👍", id: null }, count: 2, me: false }] }))
    expect((await search()).reactions_note).toBe("Reaction counts are as of the last time the message was read.")
  })

  test("nothing found is an empty result", async () => {
    const result = await search({ query: "nothing like this" })
    expect(result).toMatchObject({ messages: [], chats: [], source: "mirror" })
    expect(result).not.toHaveProperty("next_before")
  })
})
