import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MAX_SYNC_CHANNELS, MAX_SYNC_SERVERS, readSyncList, WHOLE_SERVER_CHANNELS } from "../discord/sync-list"
import { CHANNEL, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { discordSyncAdd } from "./add"
import { createSyncFixture, type SyncFixture } from "./read.testing"
import { listFileText, NEWS_CHANNEL, OTHER_SERVER, seedGuilds, THIRD_CHANNEL } from "./write.testing"
import { SYNC_WRITE_NOTE } from "./write"

let f: SyncFixture
beforeEach(async () => {
  f = await createSyncFixture()
  seedGuilds(f)
})
afterEach(async () => {
  await f.dispose()
})

describe("a server not yet in the list", () => {
  test("is followed whole", async () => {
    const result = await f.add({ server: SERVER })
    expect(result.changed).toBe(true)
    expect(result.note).toBe(SYNC_WRITE_NOTE)
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER }] })
    expect(result.servers).toMatchObject([
      { id: SERVER, name: "Alpha", follows: "server", slots: WHOLE_SERVER_CHANNELS },
    ])
  })

  test("is followed by named channels, announcement channels included", async () => {
    const result = await f.add({ server: SERVER, channels: [OTHER_CHANNEL, NEWS_CHANNEL] })
    expect(result.changed).toBe(true)
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, channels: [OTHER_CHANNEL, NEWS_CHANNEL] }] })
    expect(result.servers[0]!.channels.map((channel) => [channel.id, channel.name])).toEqual([
      [OTHER_CHANNEL, "random"],
      [NEWS_CHANNEL, "news"],
    ])
  })

  test("is followed whole with channels excluded", async () => {
    const result = await f.add({ server: SERVER, exclude: [THIRD_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }] })
    expect(result.servers[0]!.exclude).toEqual([{ id: THIRD_CHANNEL, name: "memes" }])
  })

  test("goes after the servers already in the list", async () => {
    await f.writeSyncList({ servers: [{ id: OTHER_SERVER }] })
    const result = await f.add({ server: SERVER })
    expect((await readSyncList(f.paths)).servers.map((entry) => entry.id)).toEqual([OTHER_SERVER, SERVER])
    expect(result.limits).toEqual({
      servers: { used: 2, max: MAX_SYNC_SERVERS },
      channels: { used: 2 * WHOLE_SERVER_CHANNELS, max: MAX_SYNC_CHANNELS },
      whole_server_channels: WHOLE_SERVER_CHANNELS,
    })
  })
})

describe("a server already in the list", () => {
  test("named channels merge in list order, without repeats", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [OTHER_CHANNEL, CHANNEL] }] })
    await f.add({ server: SERVER, channels: [THIRD_CHANNEL, CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({
      servers: [{ id: SERVER, channels: [OTHER_CHANNEL, CHANNEL, THIRD_CHANNEL] }],
    })
  })

  test("named channels leave the entry's exclusions", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL], exclude: [THIRD_CHANNEL, NEWS_CHANNEL] }] })
    await f.add({ server: SERVER, channels: [THIRD_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({
      servers: [{ id: SERVER, channels: [CHANNEL, THIRD_CHANNEL], exclude: [NEWS_CHANNEL] }],
    })
  })

  test("the key goes when the last exclusion does", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL], exclude: [THIRD_CHANNEL] }] })
    await f.add({ server: SERVER, channels: [THIRD_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, channels: [CHANNEL, THIRD_CHANNEL] }] })
  })

  test("exclusions of a whole server merge without repeats", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }] })
    await f.add({ server: SERVER, exclude: [OTHER_CHANNEL, THIRD_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL, OTHER_CHANNEL] }] })
  })

  test("naming an excluded channel of a whole server follows it again", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL, OTHER_CHANNEL] }] })
    await f.add({ server: SERVER, channels: [THIRD_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, exclude: [OTHER_CHANNEL] }] })
    await f.add({ server: SERVER, channels: [OTHER_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER }] })
  })

  test("other entries stay where they are", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL] }, { id: OTHER_SERVER }] })
    await f.add({ server: SERVER, channels: [OTHER_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({
      servers: [{ id: SERVER, channels: [CHANNEL, OTHER_CHANNEL] }, { id: OTHER_SERVER }],
    })
  })
})

describe("saying what the list already says", () => {
  test.each([
    ["a whole server added whole", { servers: [{ id: SERVER }] }, { server: SERVER }],
    [
      "channels already named",
      { servers: [{ id: SERVER, channels: [CHANNEL] }] },
      { server: SERVER, channels: [CHANNEL] },
    ],
    [
      "exclusions already there",
      { servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }] },
      { server: SERVER, exclude: [THIRD_CHANNEL] },
    ],
  ])("%s changes nothing", async (_name, list, args) => {
    await f.writeSyncList(list)
    const before = await listFileText(f)
    const result = await f.add(args)
    expect(result.changed).toBe(false)
    expect(result.servers).toHaveLength(1)
    expect(await listFileText(f)).toBe(before)
  })
})

describe("targets", () => {
  test("name the label and the server", async () => {
    expect(await writeTargets(discordSyncAdd, { server: SERVER }, f.ctx)).toEqual([`default/sync/${SERVER}`])
  })

  test("are any target for an account that is not signed in", async () => {
    expect(await writeTargets(discordSyncAdd, { server: SERVER, account: "nobody" }, f.ctx)).toEqual(["*"])
  })
})
