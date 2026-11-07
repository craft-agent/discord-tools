import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ingestChannels, ingestMessages, ingestServerList } from "../discord/ingest"
import type { Mirror } from "../discord/mirror"
import { snowflakeAt } from "../discord/snowflake"
import { MAX_SYNC_CHANNELS, MAX_SYNC_SERVERS } from "../discord/sync-list"
import {
  channelObject,
  ctxAt,
  messageObject,
  msgId,
  ME,
  SERVER,
  serverObject,
  userObject,
} from "../discord/objects.testing"
import { createSyncFixture, type SyncFixture } from "./read.testing"
import { SUGGEST_LIMIT_MAX } from "./suggest-schemas"

const DAY = 24 * 60 * 60 * 1000
const idAt = (base: bigint) => (n: number) => String(base + BigInt(n))
const channelId = idAt(1_400_000_000_000_000_700n)
const serverId = idAt(1_400_000_000_000_000_500n)

let f: SyncFixture
let next = 0
beforeEach(async () => {
  f = await createSyncFixture()
  next = 0
})
afterEach(async () => {
  await f.dispose()
})

/** Stores `count` messages in `channel`, newer than any before; `extra` shapes each (author, type). */
function post(m: Mirror, channel: string, count: number, extra: Record<string, unknown> = {}, first = next) {
  const ids = Array.from({ length: count }, (_, n) => msgId(first + n + 1))
  next = Math.max(next, first + count)
  ingestMessages(
    m,
    ctxAt(f.now()),
    ids.map((id) => messageObject(id, channel, extra)),
    { reactions: false },
  )
}

const mine = { author: userObject(ME) }

/** Stores a server with text channels `names` (ids from `channelId`, starting at `from`). */
function server(m: Mirror, id: string, from: number, count = 1, extra: Record<string, unknown> = {}) {
  ingestServerList(m, ctxAt(f.now()), [serverObject(id, { name: `Server ${id.slice(-2)}` })])
  const rows = Array.from({ length: count }, (_, n) =>
    channelObject(channelId(from + n), { name: `chan${from + n}`, ...extra }),
  )
  ingestChannels(m, ctxAt(f.now()), rows, id)
}

const suggest = (args: Record<string, unknown> = {}) => f.read({ method: "suggest", ...args })
const addIds = async (args?: Record<string, unknown>) => (await suggest(args)).add!.map((item) => item.channel.id)

describe("method suggest: add", () => {
  test("a channel where the account wrote is suggested, with counts and the exact apply", async () => {
    f.seed((m) => {
      server(m, SERVER, 1)
      post(m, channelId(1), 1, mine)
      post(m, channelId(1), 1)
    })
    const result = await suggest()
    expect(result.since).toBe(new Date(f.now() - 30 * DAY).toISOString())
    expect(result.add).toEqual([
      {
        channel: { id: channelId(1), name: "chan1" },
        server: { id: SERVER, name: "Server 00" },
        messages: 2,
        from_me: 1,
        last_message_at: expect.any(String),
        reason: `You wrote 1 message there since ${result.since!.slice(0, 10)}, and the sync does not follow it.`,
        apply: { tool: "discord_sync_add", args: { account: "default", server: SERVER, channels: [channelId(1)] } },
        fits: true,
      },
    ])
  })

  test("five messages by others suggest a channel, four do not", async () => {
    f.seed((m) => {
      server(m, SERVER, 1, 2)
      post(m, channelId(1), 5)
      post(m, channelId(2), 4)
    })
    const result = await suggest()
    expect(result.add!.map((item) => item.channel.id)).toEqual([channelId(1)])
    expect(result.add![0]!.reason).toStartWith("5 messages in the mirror since ")
  })

  test("messages before `after` do not count, and a date works as `after`", async () => {
    const old = (n: number) => String(BigInt(snowflakeAt(f.now() - 40 * DAY)) + BigInt(n))
    f.seed((m) => {
      server(m, SERVER, 1, 2)
      ingestMessages(m, ctxAt(f.now()), [messageObject(old(1), channelId(1), mine)], { reactions: false })
      post(m, channelId(2), 1, mine)
    })
    expect(await addIds()).toEqual([channelId(2)])
    expect(await addIds({ after: old(0) })).toEqual([channelId(2), channelId(1)])
    const dated = await suggest({ after: "2030-01-01" })
    expect(dated.add).toEqual([])
    expect(dated.since).toBe("2030-01-01T00:00:00.000Z")
  })

  test("followed and excluded channels are never suggested", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [channelId(1)], exclude: [channelId(2)] }] })
    f.seed((m) => {
      server(m, SERVER, 1, 3)
      for (const n of [1, 2, 3]) post(m, channelId(n), 1, mine)
    })
    expect(await addIds()).toEqual([channelId(3)])
  })

  test("threads, forums, voice and DMs are not suggested, nor are system messages", async () => {
    f.seed((m) => {
      server(m, SERVER, 1, 1, { type: 11 })
      server(m, serverId(1), 2, 1, { type: 15 })
      server(m, serverId(2), 3, 1)
      ingestChannels(m, ctxAt(f.now()), [channelObject(channelId(9), { type: 1 })], undefined)
      for (const n of [1, 2, 9]) post(m, channelId(n), 1, mine)
      post(m, channelId(3), 8, { type: 7 })
    })
    expect(await addIds()).toEqual([])
  })

  test("the best score comes first (own messages count triple) and `limit` cuts the list", async () => {
    f.seed((m) => {
      server(m, SERVER, 1, 3)
      post(m, channelId(1), 6)
      post(m, channelId(2), 1, mine)
      post(m, channelId(3), 2, mine)
    })
    expect(await addIds()).toEqual([channelId(3), channelId(1), channelId(2)])
    expect(await addIds({ limit: 2 })).toEqual([channelId(3), channelId(1)])
  })

  test("a channel of a server the mirror does not list is not suggested", async () => {
    f.seed((m) => {
      ingestChannels(m, ctxAt(f.now()), [channelObject(channelId(1))], SERVER)
      post(m, channelId(1), 1, mine)
    })
    expect(await addIds()).toEqual([])
  })
})

describe("method suggest: fit", () => {
  test("a whole-server entry does not fit single channels", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    f.seed((m) => {
      server(m, SERVER, 1, 11, { last_message_id: msgId(900) })
      ingestChannels(m, ctxAt(f.now()), [channelObject(channelId(20), { name: "late" })], SERVER)
      post(m, channelId(20), 1, mine)
    })
    const [item] = (await suggest()).add!
    expect(item!.channel.id).toBe(channelId(20))
    expect(item!.fits).toBe(false)
    expect(item!.why_not).toContain("discord_sync_remove")
  })

  test("an eleventh server does not fit", async () => {
    await f.writeSyncList({
      servers: Array.from({ length: MAX_SYNC_SERVERS }, (_, n) => ({ id: serverId(n), channels: [channelId(n)] })),
    })
    f.seed((m) => {
      server(m, serverId(50), 50)
      post(m, channelId(50), 1, mine)
    })
    const [item] = (await suggest()).add!
    expect(item!.fits).toBe(false)
    expect(item!.why_not).toContain(`${MAX_SYNC_SERVERS} servers`)
  })

  test("slots fill up across suggestions: the first fits, the second does not", async () => {
    const named = Array.from({ length: 9 }, (_, n) => channelId(100 + n))
    await f.writeSyncList({ servers: [{ id: serverId(1) }, { id: serverId(2) }, { id: SERVER, channels: named }] })
    f.seed((m) => {
      server(m, SERVER, 1, 2)
      post(m, channelId(1), 2, mine)
      post(m, channelId(2), 1, mine)
    })
    const result = await suggest()
    expect(result.room).toEqual({
      servers: { used: 3, max: MAX_SYNC_SERVERS },
      channels: { used: 29, max: MAX_SYNC_CHANNELS },
    })
    expect(result.add!.map((item) => [item.channel.id, item.fits])).toEqual([
      [channelId(1), true],
      [channelId(2), false],
    ])
    expect(result.add![1]!.why_not).toContain(`${MAX_SYNC_CHANNELS} channel slots`)
  })
})

describe("method suggest: remove", () => {
  test("quiet named channels go as one suggestion, an unknown one noted", async () => {
    await f.writeSyncList({
      servers: [{ id: SERVER, channels: [channelId(1), channelId(2), channelId(3), channelId(4)] }],
    })
    f.seed((m) => {
      server(m, SERVER, 1, 3)
      ingestChannels(m, ctxAt(f.now()), [channelObject(channelId(1), { last_message_id: msgId(500) })], SERVER)
      post(m, channelId(3), 1, mine)
    })
    const [item] = (await suggest()).remove!
    expect(item!.channels).toEqual([
      { id: channelId(2), name: "chan2" },
      { id: channelId(4), name: null },
    ])
    expect(item!.frees).toBe(2)
    expect(item!.reason).toContain("the mirror does not know 1 of these channels")
    expect(item!.apply).toEqual({
      tool: "discord_sync_remove",
      args: { account: "default", server: SERVER, channels: [channelId(2), channelId(4)] },
    })
  })

  test("a whole server is suggested only when all its picked channels are quiet", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }, { id: serverId(1) }] })
    const old = String(BigInt(snowflakeAt(f.now() - 40 * DAY)) + 1n)
    f.seed((m) => {
      server(m, SERVER, 1, 2, { last_message_id: old })
      server(m, serverId(1), 5, 2, { last_message_id: old })
      ingestChannels(m, ctxAt(f.now()), [channelObject(channelId(5), { last_message_id: msgId(1) })], serverId(1))
    })
    const items = (await suggest()).remove!
    expect(items.map((item) => item.server.id)).toEqual([SERVER])
    expect(items[0]!.channels).toBeNull()
    expect(items[0]!.frees).toBe(10)
    expect(items[0]!.apply).toEqual({ tool: "discord_sync_remove", args: { account: "default", server: SERVER } })
  })

  test("a whole server with no mirrored channel is not suggested", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    f.seed((m) => server(m, SERVER, 1, 0))
    expect((await suggest()).remove).toEqual([])
  })
})

describe("method suggest: without a mirror and refusals", () => {
  test("no mirror: empty suggestions, room from the list", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    const result = await suggest()
    expect(result.add).toEqual([])
    expect(result.remove).toEqual([])
    expect(result.room!.channels.used).toBe(10)
  })

  test("`after` and `limit` are not arguments of `list`", async () => {
    for (const extra of [{ after: "2026-01-01" }, { limit: 3 }]) {
      expect((await failure(f.read({ method: "list", ...extra }))).code).toBe("invalid_argument")
    }
  })

  test("an invalid `after` is refused", async () => {
    expect((await failure(suggest({ after: "yesterday" }))).code).toBe("invalid_argument")
  })

  test("a limit above the maximum is refused", async () => {
    expect((await failure(suggest({ limit: SUGGEST_LIMIT_MAX + 1 }))).code).toBe("invalid_argument")
  })
})
