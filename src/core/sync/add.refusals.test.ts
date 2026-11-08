import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { failure } from "../chats/read.testing"
import { CHANNEL, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { MAX_SYNC_CHANNELS, MAX_SYNC_SERVERS } from "../discord/sync-list"
import type { ErrorCode } from "../errors"
import { MAX_EXCLUDED_CHANNELS } from "./list-edit"
import { createSyncFixture, type SyncFixture } from "./read.testing"
import {
  ELSEWHERE_CHANNEL,
  FORUM_CHANNEL,
  listFileText,
  OTHER_SERVER,
  seedGuilds,
  serverIdAfter,
  THIRD_CHANNEL,
  THREAD_CHANNEL,
  VOICE_CHANNEL,
} from "./write.testing"

/** The `n`th made-up channel id, none of them in the mirror. */
const channelIdAfter = (n: number) => String(BigInt("1400000000000009000") + BigInt(n))

let f: SyncFixture
beforeEach(async () => {
  f = await createSyncFixture()
  seedGuilds(f)
})
afterEach(async () => {
  await f.dispose()
})

async function refusedWith(args: unknown, code: ErrorCode, text?: string): Promise<void> {
  const error = await failure(f.add(args))
  expect(error.code).toBe(code)
  if (text) expect(error.message).toContain(text)
}

describe("switching between a whole server and named channels", () => {
  test("a named entry is not widened to the whole server", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, channels: [CHANNEL, OTHER_CHANNEL] }] })
    await refusedWith({ server: SERVER }, "invalid_argument", "Only 2 named channels of this server are followed")
    await refusedWith({ server: SERVER, exclude: [THIRD_CHANNEL] }, "invalid_argument", "discord_sync_remove first")
  })

  test("a whole entry is not narrowed to named channels", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    await refusedWith({ server: SERVER, channels: [CHANNEL] }, "invalid_argument", "already follows its most active")
  })

  test("naming channels needs every one of them to be excluded", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER, exclude: [THIRD_CHANNEL] }] })
    await refusedWith({ server: SERVER, channels: [THIRD_CHANNEL, CHANNEL] }, "invalid_argument", "discord_sync_remove")
  })

  test("the file stays as it was", async () => {
    await f.writeSyncList({ servers: [{ id: SERVER }] })
    const before = await listFileText(f)
    await refusedWith({ server: SERVER, channels: [CHANNEL] }, "invalid_argument")
    expect(await listFileText(f)).toBe(before)
  })
})

describe("arguments", () => {
  test("channels and exclude together are refused", async () => {
    await refusedWith({ server: SERVER, channels: [CHANNEL], exclude: [THIRD_CHANNEL] }, "invalid_argument", "not both")
    expect(existsSync(join(f.paths.dir, "sync.json"))).toBe(false)
  })

  test.each([
    ["a name for the server", { server: "general" }],
    ["no server", {}],
    ["an empty channel list", { server: SERVER, channels: [] }],
    ["a repeated channel", { server: SERVER, channels: [CHANNEL, CHANNEL] }],
    ["a channel that is not an id", { server: SERVER, channels: ["general"] }],
    [
      "too many channels",
      { server: SERVER, channels: Array.from({ length: MAX_SYNC_CHANNELS + 1 }, (_, n) => channelIdAfter(n)) },
    ],
    [
      "too many exclusions",
      { server: SERVER, exclude: Array.from({ length: MAX_EXCLUDED_CHANNELS + 1 }, (_, n) => channelIdAfter(n)) },
    ],
    ["an argument it does not take", { server: SERVER, method: "add" }],
  ])("%s is refused", async (_name, args) => {
    await refusedWith(args, "invalid_argument")
  })

  test("an unknown account is not found", async () => {
    await refusedWith({ server: SERVER, account: "nobody" }, "not_found")
  })
})

describe("what the mirror must know", () => {
  test("a server it does not hold is not found", async () => {
    await refusedWith({ server: serverIdAfter(50) }, "not_found", "discord_chat_read method servers")
  })

  test.each([
    ["a channel it does not hold", { server: SERVER, channels: [channelIdAfter(1)] }, channelIdAfter(1)],
    ["a channel of another server", { server: SERVER, channels: [ELSEWHERE_CHANNEL] }, ELSEWHERE_CHANNEL],
    ["an exclusion of another server", { server: SERVER, exclude: [ELSEWHERE_CHANNEL] }, ELSEWHERE_CHANNEL],
  ])("%s is not found", async (_name, args, id) => {
    await refusedWith(args, "not_found", id)
    await refusedWith(args, "not_found", "discord_chat_read method channels")
  })

  test.each([
    ["a voice channel", VOICE_CHANNEL],
    ["a thread", THREAD_CHANNEL],
    ["a forum", FORUM_CHANNEL],
  ])("%s cannot be followed or excluded", async (_name, id) => {
    await refusedWith({ server: SERVER, channels: [id] }, "invalid_argument", "text and announcement channels")
    await refusedWith({ server: SERVER, exclude: [id] }, "invalid_argument", id)
  })

  test("before the first sync run nothing is known", async () => {
    const fresh = await createSyncFixture()
    try {
      const error = await failure(fresh.add({ server: SERVER }))
      expect(error.code).toBe("not_found")
      expect(error.message).toContain("The sync has not run yet")
      expect(existsSync(join(fresh.paths.dir, "sync.json"))).toBe(false)
    } finally {
      await fresh.dispose()
    }
  })
})

describe("the limits", () => {
  test("an eleventh server is refused", async () => {
    const servers = Array.from({ length: MAX_SYNC_SERVERS }, (_, n) => ({
      id: serverIdAfter(1000 + n),
      channels: [channelIdAfter(n)],
    }))
    await f.writeSyncList({ servers })
    await refusedWith({ server: SERVER }, "invalid_argument", `at most ${MAX_SYNC_SERVERS}`)
    await refusedWith({ server: SERVER }, "invalid_argument", "discord_sync_read method suggest")
  })

  test("channel slots beyond the limit are refused, saying how many", async () => {
    const channels = Array.from({ length: MAX_SYNC_CHANNELS - 5 }, (_, n) => channelIdAfter(n))
    await f.writeSyncList({ servers: [{ id: OTHER_SERVER, channels }] })
    await refusedWith(
      { server: SERVER },
      "invalid_argument",
      `would use ${MAX_SYNC_CHANNELS + 5} of its ${MAX_SYNC_CHANNELS}`,
    )
  })

  test("a named channel takes the last slot, the next one is refused", async () => {
    const channels = Array.from({ length: MAX_SYNC_CHANNELS - 1 }, (_, n) => channelIdAfter(n))
    await f.writeSyncList({ servers: [{ id: OTHER_SERVER, channels }] })
    expect((await f.add({ server: SERVER, channels: [CHANNEL] })).limits.channels.used).toBe(MAX_SYNC_CHANNELS)
    await refusedWith({ server: SERVER, channels: [OTHER_CHANNEL] }, "invalid_argument", "channel slots")
  })

  test("a server keeps at most as many exclusions as one call may name", async () => {
    const exclude = Array.from({ length: MAX_EXCLUDED_CHANNELS }, (_, n) => channelIdAfter(n))
    await f.writeSyncList({ servers: [{ id: SERVER, exclude }] })
    await refusedWith({ server: SERVER, exclude: [THIRD_CHANNEL] }, "invalid_argument", "exclude 101 channels")
  })
})
