import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { ingestChannels, ingestServerList } from "../discord/ingest"
import { markCurrent } from "../discord/mirror-cursors"
import { MAX_SYNC_CHANNELS, MAX_SYNC_SERVERS, WHOLE_SERVER_CHANNELS } from "../discord/sync-list"
import { channelObject, ctxAt, msgId, OTHER_CHANNEL, CHANNEL, SERVER, serverObject } from "../discord/objects.testing"
import { SYNC_NOTE } from "./read"
import { createSyncFixture, type SyncFixture } from "./read.testing"

const OTHER_SERVER = "1400000000000000101"
const THIRD_CHANNEL = "1400000000000000202"
const MINUTE = 60 * 1000

let f: SyncFixture
beforeEach(async () => {
  f = await createSyncFixture()
})
afterEach(async () => {
  await f.dispose()
})

describe("method list", () => {
  test("an account with no sync list follows no server", async () => {
    const result = await f.read({ method: "list" })
    expect(result).toEqual({
      method: "list",
      note: SYNC_NOTE,
      dms: "always",
      servers: [],
      limits: {
        servers: { used: 0, max: MAX_SYNC_SERVERS },
        channels: { used: 0, max: MAX_SYNC_CHANNELS },
        whole_server_channels: WHOLE_SERVER_CHANNELS,
      },
    })
  })

  test("works before the first sync run: ids with no names, nothing current", async () => {
    await f.writeSyncList({
      servers: [{ id: SERVER, channels: [CHANNEL], exclude: [OTHER_CHANNEL] }, { id: OTHER_SERVER }],
    })
    const result = await f.read({ method: "list" })
    expect(result.servers).toEqual([
      {
        id: SERVER,
        name: null,
        follows: "channels",
        channels: [{ id: CHANNEL, name: null, current: false }],
        exclude: [{ id: OTHER_CHANNEL, name: null }],
        slots: 1,
      },
      { id: OTHER_SERVER, name: null, follows: "server", channels: [], exclude: [], slots: WHOLE_SERVER_CHANNELS },
    ])
  })

  test("named channels keep list order, with mirrored names and current flags", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [OTHER_CHANNEL, CHANNEL] }] })
    f.seed((m) => {
      ingestServerList(m, ctxAt(f.now()), [serverObject(SERVER, { name: "Alpha" })])
      ingestChannels(
        m,
        ctxAt(f.now()),
        [channelObject(CHANNEL, { name: "general" }), channelObject(OTHER_CHANNEL, { name: "random" })],
        SERVER,
      )
      markCurrent(m, CHANNEL, f.now() - MINUTE)
    })
    const result = await f.read({ method: "list" })
    expect(result.servers).toEqual([
      {
        id: SERVER,
        name: "Alpha",
        follows: "channels",
        channels: [
          { id: OTHER_CHANNEL, name: "random", current: false },
          { id: CHANNEL, name: "general", current: true },
        ],
        exclude: [],
        slots: 2,
      },
    ])
  })

  test("a whole server picks its newest channels from the mirror, minus the exclusions and threads", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }] })
    f.seed((m) => {
      ingestChannels(
        m,
        ctxAt(f.now()),
        [
          channelObject(CHANNEL, { name: "old", last_message_id: msgId(1) }),
          channelObject(OTHER_CHANNEL, { name: "new", last_message_id: msgId(9) }),
          channelObject(THIRD_CHANNEL, { name: "excluded", last_message_id: msgId(99) }),
          channelObject("1400000000000000203", { name: "voice", type: 2, last_message_id: msgId(50) }),
          channelObject("1400000000000000204", { name: "thread", type: 11, last_message_id: msgId(60) }),
        ],
        SERVER,
      )
    })
    const [server] = (await f.read({ method: "list" })).servers
    expect(server!.follows).toBe("server")
    expect(server!.channels.map((channel) => [channel.id, channel.name])).toEqual([
      [OTHER_CHANNEL, "new"],
      [CHANNEL, "old"],
    ])
    expect(server!.exclude).toEqual([{ id: THIRD_CHANNEL, name: "excluded" }])
    expect(server!.slots).toBe(WHOLE_SERVER_CHANNELS)
  })

  test("a whole server lists at most ten channels", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    f.seed((m) => {
      const rows = Array.from({ length: 12 }, (_, n) =>
        channelObject(String(1_400_000_000_000_001_000n + BigInt(n)), { last_message_id: msgId(n + 1) }),
      )
      ingestChannels(m, ctxAt(f.now()), rows, SERVER)
    })
    const [server] = (await f.read({ method: "list" })).servers
    expect(server!.channels).toHaveLength(WHOLE_SERVER_CHANNELS)
  })

  test("slots add up: a whole server counts ten, named channels one each", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }, { id: OTHER_SERVER, channels: [CHANNEL, OTHER_CHANNEL] }] })
    const result = await f.read({ method: "list" })
    expect(result.limits.servers.used).toBe(2)
    expect(result.limits.channels.used).toBe(WHOLE_SERVER_CHANNELS + 2)
  })
})

describe("method list refusals", () => {
  test("an argument the method does not take is refused", async () => {
    const error = await failure(f.read({ method: "list", server: SERVER }))
    expect(error.code).toBe("invalid_argument")
  })

  test("an unknown account is not found", async () => {
    const error = await failure(f.read({ method: "list", account: "nobody" }))
    expect(error.code).toBe("not_found")
  })

  test("a malformed sync list is invalid_argument", async () => {
    await writeFile(join(f.paths.dir, "sync.json"), "{not json")
    const error = await failure(f.read({ method: "list" }))
    expect(error.code).toBe("invalid_argument")
  })
})
