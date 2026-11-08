import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { markCurrent, setCursorEdges } from "../discord/mirror-cursors"
import { ALICE, CHANNEL, msgId, SERVER } from "../discord/objects.testing"
import { createSearchFixture, numbersOf, said, seedWorld, store, type SearchFixture } from "./search.testing"

let f: SearchFixture
beforeEach(async () => {
  f = await createSearchFixture()
  seedWorld(f)
})
afterEach(async () => {
  await f.dispose()
})

const search = (args: Record<string, unknown>) => f.search({ method: "mirror", ...args })

describe("the text of a message", () => {
  test("%, _ and a backslash in the query match themselves", async () => {
    store(
      f,
      said(CHANNEL, 1, { content: "100% sure" }),
      said(CHANNEL, 2, { content: "1000 sure" }),
      said(CHANNEL, 3, { content: "snake_case" }),
      said(CHANNEL, 4, { content: "snakeXcase" }),
      said(CHANNEL, 5, { content: "a\\b" }),
      said(CHANNEL, 6, { content: "aXb" }),
    )
    expect(numbersOf(await search({ query: "100%" }))).toEqual([1])
    expect(numbersOf(await search({ query: "%" }))).toEqual([1])
    expect(numbersOf(await search({ query: "e_c" }))).toEqual([3])
    expect(numbersOf(await search({ query: "_" }))).toEqual([3])
    expect(numbersOf(await search({ query: "\\" }))).toEqual([5])
    expect(numbersOf(await search({ query: "a\\b" }))).toEqual([5])
    expect(numbersOf(await search({ query: "\\%" }))).toEqual([])
  })

  test("it is a substring, not a word, and ignores case for A–Z only", async () => {
    store(
      f,
      said(CHANNEL, 1, { content: "Hello there" }),
      said(CHANNEL, 2, { content: "cafés" }),
      said(CHANNEL, 3, { content: "'; DROP TABLE messages; --" }),
    )
    expect(numbersOf(await search({ query: "ELLO TH" }))).toEqual([1])
    expect(numbersOf(await search({ query: "CAFé" }))).toEqual([2])
    expect(numbersOf(await search({ query: "CAFÉ" }))).toEqual([])
    expect(numbersOf(await search({ query: "'; drop table messages; --" }))).toEqual([3])
    expect(numbersOf(await search({ query: "hello  there" }))).toEqual([])
  })

  test("the text is returned as stored, never clipped", async () => {
    const long = `needle ${"x".repeat(5000)}`
    store(f, said(CHANNEL, 1, { content: long }))
    expect((await search({ query: "needle" })).messages[0]!.text).toBe(long)
  })

  test("a query of the longest length is searched", async () => {
    const query = "q".repeat(1024)
    store(f, said(CHANNEL, 1, { content: `a${query}b` }))
    expect(numbersOf(await search({ query }))).toEqual([1])
  })
})

describe("the result", () => {
  test("ids above 2^53 come back exact, with the channel, the author and the server", async () => {
    store(f, said(CHANNEL, 1, { content: "big" }))
    const { messages } = await search({ query: "big" })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: msgId(1),
      channel: CHANNEL,
      author_id: ALICE,
      server: SERVER,
    })
    expect(BigInt(msgId(1)) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  test("a message has the item the chat reader gives, plus its chat and server", async () => {
    store(
      f,
      said(CHANNEL, 1, {
        content: "full https://x.test",
        pinned: true,
        edited_timestamp: "2026-01-02T03:04:05.000000+00:00",
        attachments: [
          {
            id: "1400000000000000700",
            filename: "a.png",
            content_type: "image/png",
            size: 12,
            url: "https://x.test/a",
          },
        ],
        embeds: [{ title: "T", url: "https://x.test" }],
        sticker_items: [{ id: "1400000000000000701", name: "wave", format_type: 1 }],
        reactions: [{ emoji: { name: "👍", id: null }, count: 3, me: true }],
      }),
    )
    f.seed((m) => {
      setCursorEdges(m, CHANNEL, { newest: msgId(1), oldest: msgId(1), complete: true })
      markCurrent(m, CHANNEL, f.now())
    })
    const read = await f.read({ method: "messages", channel: CHANNEL })
    expect(read.source).toBe("mirror")
    const found = await search({ query: "full" })
    const { channel, server, ...item } = found.messages[0]!
    expect(channel).toBe(CHANNEL)
    expect(server).toBe(SERVER)
    expect(item).toEqual(read.messages![0]!)
    expect(found.reactions_note).toBe(read.reactions_note)
  })

  test("the note says what was searched and carries the warning about other people's words", async () => {
    store(f, said(CHANNEL, 1))
    const result = await search({ query: "text" })
    expect(result).toMatchObject({ method: "mirror", source: "mirror" })
    expect(result.note).toContain("only what the local mirror holds, current or not")
    expect(result.note).toContain("literal substring, ignoring case for A–Z only")
    expect(result.note).toContain(UNTRUSTED_NOTE)
    expect(result).not.toHaveProperty("reactions_note")
  })

  test("a search makes no request to Discord", async () => {
    store(f, said(CHANNEL, 1))
    await search({ query: "text" })
    await search({ author: ALICE, has: ["link"] })
    expect(f.discord.requests).toHaveLength(0)
  })
})

describe("the arguments", () => {
  test("a search without a filter is refused, pointing at the chat reader", async () => {
    const error = await failure(search({ channel: CHANNEL }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("discord_chat_read method messages")
    expect((await failure(search({}))).code).toBe("invalid_argument")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("Discord's own search is not a method yet, and an unknown argument is refused", async () => {
    expect((await failure(f.search({ method: "discord", query: "a" }))).code).toBe("invalid_argument")
    expect((await failure(search({ query: "a", color: "red" }))).code).toBe("invalid_argument")
    expect((await failure(f.search({ query: "a" }))).code).toBe("invalid_argument")
  })

  test("a query, a limit and a list outside their bounds are refused", async () => {
    for (const args of [{ query: "" }, { query: "x".repeat(1025) }, { query: "a", limit: 0 }, { has: [] }]) {
      expect((await failure(search(args))).code).toBe("invalid_argument")
    }
    expect((await failure(search({ query: "a", limit: 101 }))).message).toContain("at most 100")
  })
})
