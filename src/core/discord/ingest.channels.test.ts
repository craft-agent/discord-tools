import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestChannels } from "./ingest"
import { createTestMirror, rowById, rowsOf, type TestMirror } from "./mirror.testing"
import {
  ALICE,
  BOB,
  CHANNEL,
  channelObject,
  ctxAt,
  DM,
  msgId,
  NOW,
  OTHER_CHANNEL,
  SERVER,
  userObject,
} from "./objects.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

function ingest(channels: unknown[], server?: string, now = NOW) {
  return t.write(() => ingestChannels(t.mirror, ctxAt(now), channels, server))
}

describe("ingestChannels: server channels", () => {
  test("stores a channel with the server of its guild_id, else the argument, else none", () => {
    const own = channelObject(CHANNEL, {
      guild_id: SERVER,
      parent_id: OTHER_CHANNEL,
      position: 3,
      last_message_id: msgId(7),
    })
    const counts = ingest([own, channelObject(OTHER_CHANNEL)], SERVER)
    expect(counts).toEqual({ stored: 2, deleted: 0, skipped: 0 })
    expect(rowById(t.mirror, "channels", CHANNEL)).toMatchObject({
      id: CHANNEL,
      type: 0,
      name: "general",
      position: 3,
      raw: JSON.stringify(own),
    })
    expect(
      rowsOf(
        t.mirror,
        "SELECT CAST(server AS TEXT) AS s, CAST(parent AS TEXT) AS p, CAST(last_message AS TEXT) AS l FROM channels ORDER BY id",
      ),
    ).toEqual([
      { s: SERVER, p: OTHER_CHANNEL, l: msgId(7) },
      { s: SERVER, p: null, l: null },
    ])
    ingest([channelObject(DM, { type: 1 })])
    expect(rowsOf(t.mirror, "SELECT server FROM channels WHERE id = ?", BigInt(DM))).toEqual([{ server: null }])
  })

  test("keeps last_message when a later entry lacks it, and replaces everything else", () => {
    ingest([channelObject(CHANNEL, { name: "old", last_message_id: msgId(7) })])
    ingest([channelObject(CHANNEL, { name: "new", position: 2 })], undefined, 2)
    expect(rowsOf(t.mirror, "SELECT name, position, CAST(last_message AS TEXT) AS l, updated FROM channels")).toEqual([
      { name: "new", position: 2, l: msgId(7), updated: 2 },
    ])
    ingest([{ id: CHANNEL, type: 0, last_message_id: msgId(9) }], undefined, 3)
    expect(rowsOf(t.mirror, "SELECT name, CAST(last_message AS TEXT) AS l FROM channels")).toEqual([
      { name: null, l: msgId(9) },
    ])
  })

  test("skips entries without a valid id or an integer type, and counts them", () => {
    const entries = [{ id: "0", type: 0 }, { id: CHANNEL }, { type: 0 }, 5, null, channelObject(CHANNEL)]
    expect(ingest(entries)).toEqual({ stored: 1, deleted: 0, skipped: 5 })
  })
})

describe("ingestChannels: DMs", () => {
  test("stores recipients as user ids and upserts the users", () => {
    const alice = userObject(ALICE, { global_name: "Alice" })
    const dm = channelObject(DM, { type: 3, name: null, recipients: [alice, userObject(BOB), { id: "bad" }] })
    expect(ingest([dm])).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(rowsOf(t.mirror, "SELECT recipients FROM channels")).toEqual([{ recipients: JSON.stringify([ALICE, BOB]) }])
    expect(rowsOf(t.mirror, "SELECT CAST(id AS TEXT) AS id, global_name FROM users ORDER BY id")).toEqual([
      { id: ALICE, global_name: "Alice" },
      { id: BOB, global_name: null },
    ])
  })

  test("keeps recipients when a later entry lacks them", () => {
    ingest([channelObject(DM, { type: 1, recipients: [userObject(ALICE)] })])
    ingest([channelObject(DM, { type: 1 })])
    expect(rowsOf(t.mirror, "SELECT recipients FROM channels")).toEqual([{ recipients: JSON.stringify([ALICE]) }])
  })
})

describe("ingestChannels: threads and forums", () => {
  const thread = {
    type: 11,
    parent_id: OTHER_CHANNEL,
    owner_id: ALICE,
    message_count: 12,
    flags: 2,
    applied_tags: [msgId(1), "nope"],
    thread_metadata: {
      archived: true,
      locked: false,
      archive_timestamp: "2026-01-02T00:00:00+00:00",
      create_timestamp: "2026-01-01T00:00:00+00:00",
    },
  }

  test("stores a thread's state as JSON", () => {
    ingest([channelObject(CHANNEL, thread)], SERVER)
    const [row] = rowsOf(t.mirror, "SELECT thread, forum FROM channels")
    expect(JSON.parse(row!.thread as string)).toEqual({
      archived: true,
      locked: false,
      messages: 12,
      archived_at: "2026-01-02T00:00:00+00:00",
      owner: ALICE,
      created: "2026-01-01T00:00:00+00:00",
      pinned: true,
      tags: [msgId(1)],
    })
    expect(row!.forum).toBeNull()
  })

  test("keeps the thread JSON when a later entry has no thread_metadata, and ignores it on other types", () => {
    ingest([channelObject(CHANNEL, thread)])
    ingest([channelObject(CHANNEL, { type: 11 })])
    ingest([channelObject(OTHER_CHANNEL, { thread_metadata: { archived: true } })])
    const rows = rowsOf(t.mirror, "SELECT thread IS NOT NULL AS has FROM channels ORDER BY id")
    expect(rows).toEqual([{ has: 1 }, { has: 0 }])
  })

  test("stores a forum's tags and default sort as JSON", () => {
    const tags = [
      { id: msgId(4), name: "Bug", emoji_name: "🐛" },
      { id: msgId(5), name: "Idea" },
      { id: "bad", name: "Skipped" },
      { id: msgId(6), name: "" },
    ]
    ingest([channelObject(CHANNEL, { type: 15, available_tags: tags, default_sort_order: 1 })])
    const [row] = rowsOf(t.mirror, "SELECT forum FROM channels")
    expect(JSON.parse(row!.forum as string)).toEqual({
      tags: [
        { id: msgId(4), name: "Bug", emoji: "🐛" },
        { id: msgId(5), name: "Idea", emoji: null },
      ],
      sort: 1,
    })
    ingest([channelObject(CHANNEL, { type: 15 })])
    expect(rowsOf(t.mirror, "SELECT forum IS NOT NULL AS has FROM channels")).toEqual([{ has: 1 }])
  })
})
