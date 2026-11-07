import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { markCurrent, setCursorEdges } from "../discord/mirror-cursors"
import { upsertMessage, type MessageRow } from "../discord/mirror-rows"
import { rowById } from "../discord/mirror.testing"
import { ALICE, BOB, CHANNEL, messageObject, ME, msgId, OTHER_CHANNEL, userObject } from "../discord/objects.testing"
import { idTime } from "./format"
import { createChatFixture, type ChatFixture } from "./read.testing"
import { history, seedChannels, seedHistory, serveHistory } from "./read.messages.testing"

const REACTIONS = [
  { emoji: { name: "👍", id: null }, count: 3, me: true },
  { emoji: { name: "party", id: "1400000000000000702" }, count: 1, me: false },
]

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  seedChannels(f)
})
afterEach(async () => {
  await f.dispose()
})

const messages = (args: Record<string, unknown> = {}) => f.read({ method: "messages", channel: CHANNEL, ...args })

/** The items of the messages `msgId(n)` served by the fake Discord, by number. */
async function itemsOf(...served: ReturnType<typeof messageObject>[]) {
  serveHistory(f, served)
  const result = await messages()
  return { result, byId: Object.fromEntries(result.messages!.map((item) => [item.id, item])) }
}

describe("the items of method messages", () => {
  test("a plain message", async () => {
    const { result, byId } = await itemsOf(messageObject(msgId(1), CHANNEL, { content: "  <b>hi</b>\n" }))
    expect(byId[msgId(1)]).toEqual({
      id: msgId(1),
      at: idTime(msgId(1)),
      edited_at: null,
      type: 0,
      event: null,
      from_me: false,
      author_id: ALICE,
      author: "user02",
      text: "  <b>hi</b>\n",
      reply_to: null,
      forwarded_from: null,
      attachments: [],
      embeds: [],
      stickers: [],
      reactions: [],
      pinned: false,
      mentions_me: false,
    })
    expect(result).not.toHaveProperty("reactions_note")
  })

  test("the text is never clipped", async () => {
    const long = "x".repeat(5000)
    const { byId } = await itemsOf(messageObject(msgId(1), CHANNEL, { content: long }))
    expect(byId[msgId(1)]!.text).toBe(long)
  })

  test("replies and forwards name their source; own messages are marked", async () => {
    const { byId } = await itemsOf(
      messageObject(msgId(1), CHANNEL, {
        type: 19,
        author: userObject(ME),
        message_reference: { message_id: msgId(90), channel_id: CHANNEL },
      }),
      messageObject(msgId(2), CHANNEL, {
        message_reference: { type: 1, message_id: msgId(91), channel_id: OTHER_CHANNEL },
        message_snapshots: [{ message: { content: "old" } }],
      }),
    )
    expect(byId[msgId(1)]).toMatchObject({
      from_me: true,
      event: null,
      reply_to: { message: msgId(90), channel: CHANNEL },
      forwarded_from: null,
    })
    expect(byId[msgId(2)]).toMatchObject({
      reply_to: null,
      forwarded_from: { message: msgId(91), channel: OTHER_CHANNEL },
    })
  })

  test("attachments, embeds, stickers, reactions, pins and edits", async () => {
    const { result, byId } = await itemsOf(
      messageObject(msgId(1), CHANNEL, {
        edited_timestamp: "2026-01-02T03:04:05.000000+00:00",
        pinned: true,
        attachments: [
          {
            id: "1400000000000000700",
            filename: "a.png",
            content_type: "image/png",
            size: 12,
            url: "https://x.test/a",
          },
        ],
        embeds: [{ title: "T", description: "D", url: "https://x.test", fields: [{ name: "n", value: "v" }] }],
        sticker_items: [{ id: "1400000000000000701", name: "wave", format_type: 1 }],
        reactions: REACTIONS,
      }),
    )
    expect(byId[msgId(1)]).toMatchObject({
      edited_at: "2026-01-02T03:04:05.000Z",
      pinned: true,
      attachments: [{ id: "1400000000000000700", name: "a.png", type: "image/png", size: 12, url: "https://x.test/a" }],
      embeds: [{ title: "T", description: "D", url: "https://x.test", fields: [{ name: "n", value: "v" }] }],
      stickers: [{ id: "1400000000000000701", name: "wave" }],
      reactions: [
        { emoji: "👍", count: 3, me: true },
        { emoji: "party:1400000000000000702", count: 1, me: false },
      ],
    })
    expect(result.reactions_note).toBe("Reaction counts are as of the last time the message was read.")
  })

  test.each([
    [6, "pinned a message"],
    [7, "joined"],
    [8, "boosted"],
    [18, "started a thread"],
    [46, "poll result"],
    [21, "system"],
    [0, null],
    [19, null],
  ])("type %d is event %j", async (type, event) => {
    const { byId } = await itemsOf(messageObject(msgId(1), CHANNEL, { type }))
    expect(byId[msgId(1)]).toMatchObject({ type, event })
  })

  test("it mentions the user when a mention names them, or it mentions everyone", async () => {
    const { byId } = await itemsOf(
      messageObject(msgId(1), CHANNEL, { mentions: [userObject(ME)] }),
      messageObject(msgId(2), CHANNEL, { mention_everyone: true }),
      messageObject(msgId(3), CHANNEL, { mentions: [userObject(BOB)] }),
    )
    expect([1, 2, 3].map((n) => byId[msgId(n)]!.mentions_me)).toEqual([true, true, false])
  })

  test("the author is named by nickname, else display name, else username", async () => {
    const bob = userObject(BOB, { username: "bobby", global_name: "Bob B" })
    const { byId } = await itemsOf(
      messageObject(msgId(1), CHANNEL, { author: bob, member: { nick: "Bobster" } }),
      messageObject(msgId(2), CHANNEL, { author: bob }),
      messageObject(msgId(3), CHANNEL, { author: userObject(ALICE, { username: "alice" }) }),
    )
    expect([1, 2, 3].map((n) => byId[msgId(n)]!.author)).toEqual(["Bobster", "Bob B", "alice"])
  })

  test("a mirror result has the same items as a live one", async () => {
    const served = history(3, 2, 1)
    served[1] = { ...served[1]!, reactions: REACTIONS } as (typeof served)[number]
    serveHistory(f, served)
    const live = await messages()
    expect(live.source).toBe("live")
    f.seed((m) => {
      setCursorEdges(m, CHANNEL, { newest: msgId(3), oldest: msgId(1), complete: true })
      markCurrent(m, CHANNEL, f.now())
    })
    const mirror = await messages()
    expect(mirror.source).toBe("mirror")
    expect(mirror.messages).toEqual(live.messages)
    expect(mirror.reactions_note).toBe(live.reactions_note)
    expect(mirror.messages![1]!.reactions).toHaveLength(2)
  })

  test("damaged JSON columns read as empty lists", async () => {
    seedHistory(f, [1], { current: true, complete: true })
    f.seed((m) => {
      const row = rowById(m, "messages", msgId(1))!
      upsertMessage(
        m,
        {
          ...(row as unknown as MessageRow),
          id: BigInt(msgId(1)),
          channel: BigInt(CHANNEL),
          server: null,
          author: BigInt(ALICE),
          ref_message: null,
          ref_channel: null,
          attachments: "not json",
          embeds: '{"a":1}',
          stickers: '[{"id":5}]',
          reactions: "[1",
          mentions: "{}",
        },
        true,
      )
    })
    const [item] = (await messages()).messages!
    expect(item).toMatchObject({ attachments: [], embeds: [], stickers: [], reactions: [], mentions_me: false })
  })
})
