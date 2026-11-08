import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ALICE, BOB, CHANNEL, ME, msgId, userObject } from "../discord/objects.testing"
import { createSearchFixture, numbersOf, said, seedWorld, store, type SearchFixture } from "./search.testing"

const PARTY = "1400000000000000702"
const HEART = "\u2764"
const HEART_WITH_MARK = `${HEART}\ufe0f`
const FILE = (type: string, name = "f") => ({
  id: "1400000000000000700",
  filename: name,
  content_type: type,
  size: 1,
  url: "https://cdn.test/f",
})
const REACTION = (name: string, me: boolean, id: string | null = null) => ({ emoji: { name, id }, count: 1, me })

let f: SearchFixture
beforeEach(async () => {
  f = await createSearchFixture()
  seedWorld(f)
  store(
    f,
    said(CHANNEL, 1),
    said(CHANNEL, 2, { author: userObject(BOB) }),
    said(CHANNEL, 3, { mentions: [userObject(BOB), userObject(ME)] }),
    said(CHANNEL, 4, { content: "see HTTPS://x.test/a" }),
    said(CHANNEL, 5, { content: "old http://x.test" }),
    said(CHANNEL, 6, { content: "httpx: not a link" }),
    said(CHANNEL, 7, { attachments: [FILE("image/png")] }),
    said(CHANNEL, 8, { attachments: [FILE("video/mp4")] }),
    said(CHANNEL, 9, { attachments: [FILE("audio/ogg")] }),
    said(CHANNEL, 10, { attachments: [FILE("application/pdf")] }),
    said(CHANNEL, 11, { embeds: [{ title: "T" }] }),
    said(CHANNEL, 12, { sticker_items: [{ id: "1400000000000000701", name: "wave", format_type: 1 }] }),
    said(CHANNEL, 13, { poll: { question: { text: "q" }, answers: [] } }),
    said(CHANNEL, 14, { pinned: true }),
    said(CHANNEL, 15, { reactions: [REACTION("👍", true)] }),
    said(CHANNEL, 16, { reactions: [REACTION("party", false, PARTY)] }),
    said(CHANNEL, 17, {
      author: userObject(BOB),
      content: "pic https://x.test/p.jpg",
      attachments: [FILE("image/jpeg")],
      embeds: [{ title: "P" }],
    }),
    said(CHANNEL, 18, { reactions: [REACTION(HEART_WITH_MARK, true), REACTION("party", true, PARTY)] }),
  )
})
afterEach(async () => {
  await f.dispose()
})

const search = async (args: Record<string, unknown>) =>
  numbersOf(await f.search({ method: "mirror", limit: 100, ...args }))

describe("one filter", () => {
  test("author", async () => {
    expect(await search({ author: BOB })).toEqual([17, 2])
    expect(await search({ author: ME })).toEqual([])
  })

  test("mentions matches the ids in the stored list", async () => {
    expect(await search({ mentions: BOB })).toEqual([3])
    expect(await search({ mentions: ME })).toEqual([3])
    expect(await search({ mentions: ALICE })).toEqual([])
  })

  test.each([
    ["link", [17, 5, 4]],
    ["file", [17, 10, 9, 8, 7]],
    ["image", [17, 7]],
    ["video", [8]],
    ["sound", [9]],
    ["embed", [17, 11]],
    ["sticker", [12]],
    ["poll", [13]],
  ])("has %s", async (has, expected) => {
    expect(await search({ has: [has] })).toEqual(expected)
  })

  test("pinned true keeps pins and false keeps the rest", async () => {
    expect(await search({ pinned: true })).toEqual([14])
    const rest = await search({ pinned: false })
    expect(rest).toHaveLength(17)
    expect(rest).not.toContain(14)
  })

  test("reacted tells the account's own reactions from the others", async () => {
    expect(await search({ reacted: true })).toEqual([18, 15])
    const rest = await search({ reacted: false })
    expect(rest).toHaveLength(16)
    expect(rest).toContain(16)
    expect(rest).not.toContain(15)
  })

  test("emoji, Unicode or custom, in any of the forms a custom one is written", async () => {
    expect(await search({ emoji: "👍" })).toEqual([15])
    for (const emoji of [`party:${PARTY}`, `<:party:${PARTY}>`, `<a:party:${PARTY}>`]) {
      expect(await search({ emoji })).toEqual([18, 16])
    }
    expect(await search({ emoji: "party" })).toEqual([])
    expect(await search({ emoji: `other:${PARTY}` })).toEqual([])
    expect(await search({ emoji: "🎉" })).toEqual([])
  })

  test("an emoji is found with or without its picture-form mark", async () => {
    expect(await search({ emoji: HEART_WITH_MARK })).toEqual([18])
    expect(await search({ emoji: HEART })).toEqual([18])
  })
})

describe("filters together", () => {
  test("a message must satisfy every one", async () => {
    expect(await search({ has: ["image", "link"] })).toEqual([17])
    expect(await search({ has: ["image", "file", "embed", "link"] })).toEqual([17])
    expect(await search({ has: ["image"], author: BOB })).toEqual([17])
    expect(await search({ has: ["video"], author: BOB })).toEqual([])
    expect(await search({ query: "text 00", author: BOB })).toEqual([2])
  })

  test("a query narrows the other filters", async () => {
    expect(await search({ query: "pic", has: ["link"] })).toEqual([17])
    expect(await search({ query: "old", has: ["link"], pinned: false })).toEqual([5])
    expect(await search({ query: "old", has: ["image"] })).toEqual([])
  })

  test("reactions combine with the account's own flag", async () => {
    expect(await search({ emoji: `party:${PARTY}`, reacted: true })).toEqual([18])
    expect(await search({ emoji: `party:${PARTY}`, reacted: false })).toEqual([16])
    expect(await search({ emoji: "👍", reacted: false })).toEqual([])
  })

  test("a filter can be combined with the bounds and a scope", async () => {
    expect(await search({ has: ["file"], before: msgId(10), after: msgId(7) })).toEqual([9, 8])
    expect(await search({ has: ["file"], channel: CHANNEL, author: BOB })).toEqual([17])
  })
})

describe("damaged stored lists", () => {
  test("a column that is not a list matches nothing and breaks nothing", async () => {
    f.seed((m) =>
      m
        .prepare("UPDATE messages SET attachments = 'not json', mentions = '{}', reactions = '[1' WHERE id = ?")
        .run(BigInt(msgId(7))),
    )
    expect(await search({ has: ["image"] })).toEqual([17])
    expect(await search({ has: ["file"] })).toEqual([17, 10, 9, 8])
    expect(await search({ mentions: BOB })).toEqual([3])
    expect(await search({ emoji: "👍" })).toEqual([15])
    expect(await search({ reacted: true })).toEqual([18, 15])
    expect(await search({ reacted: false })).toContain(7)
  })

  test("a request that no filter can make is still refused", async () => {
    expect((await failure(f.search({ method: "mirror", has: ["gif"] }))).code).toBe("invalid_argument")
    expect((await failure(f.search({ method: "mirror", has: ["link", "link"] }))).code).toBe("invalid_argument")
  })
})
