import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestServerList } from "../discord/ingest"
import { CURRENT_MS, markCurrent } from "../discord/mirror-cursors"
import { rowsOf } from "../discord/mirror.testing"
import { channelObject, msgId, SERVER, serverObject } from "../discord/objects.testing"
import { idTime } from "./format"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"

const OTHER_SERVER = "1400000000000000101"
const TEXT_CATEGORY = "1400000000000000400"
const VOICE_CATEGORY = "1400000000000000401"
const GENERAL = "1400000000000000410"
const RANDOM = "1400000000000000411"
const LOBBY = "1400000000000000412"
const LOOSE = "1400000000000000413"
const THREAD = "1400000000000000414"
const FORUM = "1400000000000000415"

const path = `/guilds/${SERVER}/channels`

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  f.seed((m) => ingestServerList(m, f.ingestContext(), [serverObject(SERVER)]))
})
afterEach(async () => {
  await f.dispose()
})

function serverChannels() {
  f.discord.route("GET", path, {
    status: 200,
    json: [
      channelObject(TEXT_CATEGORY, { type: 4, name: "Text", position: 1 }),
      channelObject(VOICE_CATEGORY, { type: 4, name: "Voice", position: 0 }),
      channelObject(GENERAL, { parent_id: TEXT_CATEGORY, position: 1, last_message_id: msgId(5) }),
      channelObject(RANDOM, { name: "random", parent_id: TEXT_CATEGORY, position: 0 }),
      channelObject(LOBBY, { type: 2, name: "lobby", parent_id: VOICE_CATEGORY, position: 0 }),
      channelObject(LOOSE, { type: 5, name: "news", position: 5 }),
      channelObject(THREAD, { type: 11, name: "a thread", parent_id: GENERAL, position: 0 }),
      channelObject(FORUM, { type: 15, name: "ideas", parent_id: TEXT_CATEGORY, position: 2 }),
    ],
  })
}

describe("method channels", () => {
  test("an unknown server is not found, and nothing is requested", async () => {
    const error = await failure(f.read({ method: "channels", server: OTHER_SERVER }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("list servers with method servers first")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("lists the channels by category and position, without categories and threads", async () => {
    serverChannels()
    const result = await f.read({ method: "channels", server: SERVER })
    expect(result.source).toBe("live")
    expect(result.channels?.map((channel) => channel.id)).toEqual([LOOSE, LOBBY, RANDOM, GENERAL, FORUM])
    expect(result.channels?.[0]).toEqual({
      id: LOOSE,
      name: "news",
      kind: "announcement",
      type: 5,
      category_id: null,
      category: null,
      position: 5,
      last_message_at: null,
      followed: false,
      current: false,
    })
    expect(result.channels?.[1]).toMatchObject({ kind: "voice", category_id: VOICE_CATEGORY, category: "Voice" })
    expect(result.channels?.[3]).toMatchObject({
      name: "general",
      kind: "text",
      category: "Text",
      last_message_at: idTime(msgId(5)),
    })
    expect(result.channels?.[4]).toMatchObject({ kind: "forum", type: 15 })
  })

  test("stores every channel it read, with the server", async () => {
    serverChannels()
    await f.read({ method: "channels", server: SERVER })
    const stored = f.inspect((m) =>
      rowsOf(m, "SELECT CAST(id AS TEXT) AS id, CAST(server AS TEXT) AS server FROM channels"),
    )
    expect(stored).toHaveLength(8)
    expect(stored.every((row) => row.server === SERVER)).toBe(true)
    expect(f.discord.api[0]!.headers.find(([name]) => name === "referer")?.[1]).toContain(`/channels/${SERVER}`)
  })

  test("followed: a whole server follows the text channels a sync run picks, never an excluded one", async () => {
    serverChannels()
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [RANDOM] }] })
    const result = await f.read({ method: "channels", server: SERVER })
    const followed = Object.fromEntries(result.channels!.map((channel) => [channel.id, channel.followed]))
    expect(followed).toEqual({ [LOOSE]: true, [LOBBY]: false, [RANDOM]: false, [GENERAL]: true, [FORUM]: false })
  })

  test("followed: named channels follow only themselves, and another server's entry follows none", async () => {
    serverChannels()
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [GENERAL, THREAD] }] })
    let result = await f.read({ method: "channels", server: SERVER })
    expect(result.channels?.filter((channel) => channel.followed).map((channel) => channel.id)).toEqual([GENERAL])
    await f.writeSyncList({ servers: [{ id: OTHER_SERVER }] })
    result = await f.read({ method: "channels", server: SERVER })
    expect(result.channels?.some((channel) => channel.followed)).toBe(false)
  })

  test("current comes from a sync run's mark, for under 15 minutes", async () => {
    serverChannels()
    f.seed((m) => {
      markCurrent(m, GENERAL, f.now())
      markCurrent(m, RANDOM, f.now() - CURRENT_MS - 1)
    })
    const result = await f.read({ method: "channels", server: SERVER })
    const current = Object.fromEntries(result.channels!.map((channel) => [channel.id, channel.current]))
    expect(current).toMatchObject({ [GENERAL]: true, [RANDOM]: false, [LOBBY]: false })
  })

  test("reading marks nothing current", async () => {
    serverChannels()
    f.seed((m) => markCurrent(m, GENERAL, 123))
    await f.read({ method: "channels", server: SERVER })
    expect(f.inspect((m) => rowsOf(m, "SELECT CAST(channel AS TEXT) AS channel, synced_at FROM cursors"))).toEqual([
      { channel: GENERAL, synced_at: 123 },
    ])
  })

  test("a refusal is forbidden and stores nothing", async () => {
    f.discord.route("GET", path, { status: 403, json: { code: 50001, message: "Missing Access" } })
    expect((await failure(f.read({ method: "channels", server: SERVER }))).code).toBe("forbidden")
    expect(f.inspect((m) => rowsOf(m, "SELECT id FROM channels"))).toEqual([])
  })

  test("a channel of another server in the answer is an upstream error and stores nothing", async () => {
    f.discord.route("GET", path, { status: 200, json: [channelObject(GENERAL, { guild_id: OTHER_SERVER })] })
    expect((await failure(f.read({ method: "channels", server: SERVER }))).code).toBe("upstream_error")
    expect(f.inspect((m) => rowsOf(m, "SELECT id FROM channels"))).toEqual([])
  })
})
