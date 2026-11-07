import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestChannels, ingestMessages } from "./ingest"
import { createTestMirror, rowById, rowsOf, type TestMirror } from "./mirror.testing"
import {
  ALICE,
  BOB,
  CHANNEL,
  channelObject,
  ctxAt,
  ME,
  messageObject,
  msgId,
  NOW,
  OTHER_CHANNEL,
  SERVER,
  userObject,
} from "./objects.testing"
import { snowflakeTime } from "./snowflake"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

function ingest(messages: unknown[], reactions = true, now = NOW) {
  return t.write(() => ingestMessages(t.mirror, ctxAt(now), messages, { reactions }))
}

function stored(id: string) {
  return rowById(t.mirror, "messages", id)!
}

describe("ingestMessages: columns", () => {
  test("stores a plain message and its author, with ids exact above 2^53", () => {
    const message = messageObject(msgId(1), CHANNEL, {
      guild_id: SERVER,
      flags: 4,
      pinned: true,
      member: { nick: "Al" },
    })
    expect(ingest([message])).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(stored(msgId(1))).toMatchObject({
      id: msgId(1),
      from_me: 0,
      type: 0,
      content: message.content,
      author_nick: "Al",
      ref_kind: null,
      ref_message: null,
      mention_everyone: 0,
      pinned: 1,
      flags: 4,
      created_at: snowflakeTime(msgId(1)),
      edited_at: null,
      raw: JSON.stringify(message),
      updated: NOW,
    })
    expect(
      rowsOf(
        t.mirror,
        "SELECT CAST(channel AS TEXT) AS c, CAST(server AS TEXT) AS s, CAST(author AS TEXT) AS a FROM messages",
      ),
    ).toEqual([{ c: CHANNEL, s: SERVER, a: ALICE }])
    expect(rowsOf(t.mirror, "SELECT CAST(id AS TEXT) AS id FROM users")).toEqual([{ id: ALICE }])
  })

  test("marks the signed-in user's own messages and reads the edit time", () => {
    ingest([
      messageObject(msgId(1), CHANNEL, {
        author: userObject(ME),
        edited_timestamp: "2026-01-02T03:04:05.000000+00:00",
      }),
    ])
    expect(stored(msgId(1))).toMatchObject({ from_me: 1, edited_at: Date.parse("2026-01-02T03:04:05.000Z") })
  })

  test("takes the server from the stored channel when the message names none", () => {
    t.write(() => ingestChannels(t.mirror, ctxAt(), [channelObject(CHANNEL)], SERVER))
    ingest([messageObject(msgId(1), CHANNEL), messageObject(msgId(2), OTHER_CHANNEL)])
    expect(rowsOf(t.mirror, "SELECT CAST(server AS TEXT) AS s FROM messages ORDER BY id")).toEqual([
      { s: SERVER },
      { s: null },
    ])
  })

  test("stores mentions, mentioned roles and everyone, and upserts the mentioned users", () => {
    ingest([
      messageObject(msgId(1), CHANNEL, {
        mentions: [userObject(BOB, { global_name: "Bob" }), { id: "bad" }],
        mention_roles: [msgId(9), "bad"],
        mention_everyone: true,
      }),
    ])
    expect(stored(msgId(1))).toMatchObject({
      mentions: JSON.stringify([BOB]),
      mention_roles: JSON.stringify([msgId(9)]),
      mention_everyone: 1,
    })
    expect(rowsOf(t.mirror, "SELECT CAST(id AS TEXT) AS id, global_name FROM users ORDER BY id")).toEqual([
      { id: ALICE, global_name: null },
      { id: BOB, global_name: "Bob" },
    ])
  })

  test("stores attachments, stickers and clipped embeds", () => {
    const long = "é".repeat(600)
    ingest([
      messageObject(msgId(1), CHANNEL, {
        attachments: [
          { id: msgId(20), filename: "a.png", content_type: "image/png", size: 12, url: "https://cdn.example/a.png" },
          "x",
        ],
        sticker_items: [{ id: msgId(21), name: "wave", format_type: 1 }, { name: "no id" }],
        embeds: [
          {
            title: "T".repeat(300),
            description: long,
            url: "https://e.example",
            author: { name: "N" },
            provider: { name: "P" },
            footer: { text: "F" },
            fields: [1, 2, 3, 4, 5, 6].map((n) => ({ name: `n${n}`, value: "v".repeat(400) })),
          },
          { color: 5 },
          "x",
        ],
      }),
    ])
    const row = stored(msgId(1))
    expect(JSON.parse(row.attachments as string)).toEqual([
      { id: msgId(20), name: "a.png", type: "image/png", size: 12, url: "https://cdn.example/a.png" },
    ])
    expect(JSON.parse(row.stickers as string)).toEqual([{ id: msgId(21), name: "wave" }])
    const [embed] = JSON.parse(row.embeds as string)
    expect(JSON.parse(row.embeds as string)).toHaveLength(1)
    expect(embed.title).toHaveLength(256)
    expect(Array.from(embed.description)).toHaveLength(500)
    expect(embed).toMatchObject({ url: "https://e.example", author: "N", site: "P", footer: "F" })
    expect(embed.fields).toHaveLength(5)
    expect(embed.fields[0]).toEqual({ name: "n1", value: "v".repeat(300) })
  })
})

describe("ingestMessages: references", () => {
  test("a reference on a reply message is a reply", () => {
    ingest([
      messageObject(msgId(2), CHANNEL, { type: 19, message_reference: { message_id: msgId(1), channel_id: CHANNEL } }),
    ])
    expect(
      rowsOf(t.mirror, "SELECT ref_kind, CAST(ref_message AS TEXT) AS m, CAST(ref_channel AS TEXT) AS c FROM messages"),
    ).toEqual([{ ref_kind: "reply", m: msgId(1), c: CHANNEL }])
  })

  test("a reference of type 1, or snapshots, is a forward", () => {
    ingest([
      messageObject(msgId(2), CHANNEL, {
        message_reference: { type: 1, message_id: msgId(1), channel_id: OTHER_CHANNEL },
      }),
      messageObject(msgId(3), CHANNEL, { message_snapshots: [{ message: { content: "x" } }] }),
    ])
    expect(
      rowsOf(
        t.mirror,
        "SELECT ref_kind, CAST(ref_message AS TEXT) AS m, CAST(ref_channel AS TEXT) AS c FROM messages ORDER BY id",
      ),
    ).toEqual([
      { ref_kind: "forward", m: msgId(1), c: OTHER_CHANNEL },
      { ref_kind: "forward", m: null, c: null },
    ])
  })

  test("a reference on any other message type, or a reply without a message, is neither", () => {
    ingest([
      messageObject(msgId(2), CHANNEL, { type: 21, message_reference: { message_id: msgId(1) } }),
      messageObject(msgId(3), CHANNEL, { type: 19, message_reference: { channel_id: CHANNEL } }),
    ])
    expect(rowsOf(t.mirror, "SELECT ref_kind, ref_message, ref_channel FROM messages")).toEqual([
      { ref_kind: null, ref_message: null, ref_channel: null },
      { ref_kind: null, ref_message: null, ref_channel: null },
    ])
  })
})

describe("ingestMessages: updates and malformed input", () => {
  test("a later copy replaces the content and edit time", () => {
    ingest([messageObject(msgId(1), CHANNEL, { content: "first" })])
    ingest(
      [messageObject(msgId(1), CHANNEL, { content: "second", edited_timestamp: "2026-02-01T00:00:00+00:00" })],
      true,
      9,
    )
    expect(rowsOf(t.mirror, "SELECT count(*) AS n FROM messages")).toEqual([{ n: 1 }])
    expect(stored(msgId(1))).toMatchObject({
      content: "second",
      edited_at: Date.parse("2026-02-01T00:00:00Z"),
      updated: 9,
    })
  })

  test("skips entries without a valid id or channel and counts them", () => {
    const good = messageObject(msgId(1), CHANNEL)
    const entries = [
      { ...good, id: "x" },
      { ...good, channel_id: undefined },
      { ...good, channel_id: "012" },
      null,
      7,
      [],
      good,
    ]
    expect(ingest(entries)).toEqual({ stored: 1, deleted: 0, skipped: 6 })
  })

  test("takes missing optional fields as empty", () => {
    ingest([{ id: msgId(1), channel_id: CHANNEL }])
    expect(stored(msgId(1))).toMatchObject({
      author: null,
      from_me: 0,
      content: "",
      type: 0,
      flags: 0,
      attachments: null,
      embeds: null,
      reactions: null,
    })
  })
})
