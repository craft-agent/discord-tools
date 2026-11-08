import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { CHANNEL, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { readSyncList } from "../discord/sync-list"
import { writeTargets } from "../targets"
import { MAX_EXCLUDED_CHANNELS } from "./list-edit"
import { createSyncFixture, type SyncFixture } from "./read.testing"
import { discordSyncRemove } from "./remove"
import { listFileText, OTHER_SERVER, seedGuilds, serverIdAfter, THIRD_CHANNEL } from "./write.testing"
import { SYNC_WRITE_NOTE } from "./write"

let f: SyncFixture
beforeEach(async () => {
  f = await createSyncFixture()
  seedGuilds(f)
})
afterEach(async () => {
  await f.dispose()
})

describe("a whole entry", () => {
  test("goes, and the others stay", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }, { id: OTHER_SERVER }] })
    const result = await f.remove({ server: SERVER })
    expect(result.changed).toBe(true)
    expect(result.message).toBeUndefined()
    expect(result.note).toBe(SYNC_WRITE_NOTE)
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: OTHER_SERVER }] })
    expect(result.servers.map((server) => server.id)).toEqual([OTHER_SERVER])
    expect(result.limits.servers.used).toBe(1)
  })

  test("the last entry leaves an empty list", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    await f.remove({ server: SERVER })
    expect(await readSyncList(f.paths)).toEqual({ servers: [] })
  })

  test("grows its exclusions when channels are named", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }] })
    const result = await f.remove({ server: SERVER, channels: [OTHER_CHANNEL, THIRD_CHANNEL] })
    expect(result.changed).toBe(true)
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL, OTHER_CHANNEL] }] })
    expect(result.servers[0]!.exclude).toEqual([
      { id: THIRD_CHANNEL, name: "memes" },
      { id: OTHER_CHANNEL, name: "random" },
    ])
  })

  test("takes a first exclusion", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    await f.remove({ server: SERVER, channels: [CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, exclude: [CHANNEL] }] })
  })

  test("with every named channel already excluded changes nothing", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [CHANNEL] }] })
    const before = await listFileText(f)
    const result = await f.remove({ server: SERVER, channels: [CHANNEL] })
    expect(result.changed).toBe(false)
    expect(result.message).toContain("already excluded")
    expect(await listFileText(f)).toBe(before)
  })

  test("keeps no more exclusions than an entry may", async () => {
    const exclude = Array.from({ length: MAX_EXCLUDED_CHANNELS }, (_, n) =>
      String(BigInt("1400000000000009000") + BigInt(n)),
    )
    await f.writeSyncList({ servers: [{ id: SERVER, exclude }] })
    const error = await failure(f.remove({ server: SERVER, channels: [CHANNEL] }))
    expect(error.code).toBe("invalid_argument")
  })
})

describe("an entry of named channels", () => {
  test("loses the named channels and keeps the rest in order", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL, OTHER_CHANNEL, THIRD_CHANNEL] }] })
    const result = await f.remove({ server: SERVER, channels: [OTHER_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, channels: [CHANNEL, THIRD_CHANNEL] }] })
    expect(result.limits.channels.used).toBe(2)
  })

  test("ignores a channel it does not hold", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL, OTHER_CHANNEL] }] })
    await f.remove({ server: SERVER, channels: [OTHER_CHANNEL, THIRD_CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: SERVER, channels: [CHANNEL] }] })
  })

  test("goes when no channel is left, with its exclusions", async () => {
    await f.writeSyncList({
      servers: [{ id: SERVER, channels: [CHANNEL], exclude: [THIRD_CHANNEL] }, { id: OTHER_SERVER }],
    })
    await f.remove({ server: SERVER, channels: [CHANNEL] })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: OTHER_SERVER }] })
  })

  test("with no channel of the list changes nothing", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL] }] })
    const before = await listFileText(f)
    const result = await f.remove({ server: SERVER, channels: [THIRD_CHANNEL] })
    expect(result.changed).toBe(false)
    expect(result.message).toContain("None of those channels is followed")
    expect(await listFileText(f)).toBe(before)
  })
})

describe("what is not in the list", () => {
  test("a server that is not there changes nothing and says so", async () => {
    await f.writeSyncList({ servers: [{ id: OTHER_SERVER }] })
    const before = await listFileText(f)
    const result = await f.remove({ server: SERVER })
    expect(result).toMatchObject({
      changed: false,
      message: `Server ${SERVER} is not in the sync list; nothing changed.`,
    })
    expect(result.servers.map((server) => server.id)).toEqual([OTHER_SERVER])
    expect(await listFileText(f)).toBe(before)
  })

  test("with no sync list at all, no file is made", async () => {
    const result = await f.remove({ server: SERVER })
    expect(result).toMatchObject({ changed: false, servers: [] })
    expect(result.message).toContain("not in the sync list")
    expect(existsSync(join(f.paths.dir, "sync.json"))).toBe(false)
  })

  test("removing twice is the same as removing once", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    expect((await f.remove({ server: SERVER })).changed).toBe(true)
    expect((await f.remove({ server: SERVER })).changed).toBe(false)
  })
})

describe("without the mirror's knowledge", () => {
  test("a server the mirror does not hold can still be removed", async () => {
    const left = serverIdAfter(50)
    await f.writeSyncList({ servers: [{ id: left, channels: [CHANNEL] }, { id: OTHER_SERVER }] })
    await f.remove({ server: left })
    expect(await readSyncList(f.paths)).toEqual({ servers: [{ id: OTHER_SERVER }] })
  })

  test("before the first sync run it works, and names are null", async () => {
    const fresh = await createSyncFixture()
    try {
      await fresh.writeSyncList({
        servers: [
          { id: SERVER, exclude: [THIRD_CHANNEL] },
          { id: OTHER_SERVER, channels: [CHANNEL] },
        ],
      })
      const result = await fresh.remove({ server: SERVER, channels: [OTHER_CHANNEL] })
      expect(result.servers[0]).toMatchObject({
        id: SERVER,
        name: null,
        exclude: [
          { id: THIRD_CHANNEL, name: null },
          { id: OTHER_CHANNEL, name: null },
        ],
      })
      expect(result.servers[1]!.channels).toEqual([{ id: CHANNEL, name: null, current: false }])
    } finally {
      await fresh.dispose()
    }
  })
})

describe("arguments and targets", () => {
  test.each([
    ["a name for the server", { server: "general" }],
    ["no server", {}],
    ["an empty channel list", { server: SERVER, channels: [] }],
    ["a repeated channel", { server: SERVER, channels: [CHANNEL, CHANNEL] }],
    ["an argument it does not take", { server: SERVER, exclude: [CHANNEL] }],
  ])("%s is refused", async (_name, args) => {
    expect((await failure(f.remove(args))).code).toBe("invalid_argument")
  })

  test("an unknown account is not found", async () => {
    expect((await failure(f.remove({ server: SERVER, account: "nobody" }))).code).toBe("not_found")
  })

  test("targets name the label and the server", async () => {
    expect(await writeTargets(discordSyncRemove, { server: SERVER }, f.ctx)).toEqual([`default/sync/${SERVER}`])
    expect(await writeTargets(discordSyncRemove, { server: SERVER, account: "nobody" }, f.ctx)).toEqual(["*"])
  })
})
