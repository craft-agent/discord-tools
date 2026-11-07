import type { DiscordClientOptions } from "./client"
import { createHarness, FAKE_TOKEN, TOKEN_VARIABLE } from "./client.testing"
import { inTransaction, openMirrorForRead, openMirrorForWrite, type Mirror } from "./mirror"
import { SYNC_CHANNEL, SYNC_ME } from "./sync-fixtures.testing"
import { runSync } from "./sync"

export { SYNC_CHANNEL, SYNC_ME, syncMessage, syncMessages } from "./sync-fixtures.testing"

export async function createSyncHarness() {
  const h = await createHarness()
  await h.warm()
  h.discord.route("GET", "/users/@me", { status: 200, json: { id: SYNC_ME, username: "tester" } })
  h.discord.route("GET", "/users/@me/channels", { status: 200, json: [] })
  const options: DiscordClientOptions = {
    stateDir: h.stateDir,
    paths: h.paths,
    tokenVariable: TOKEN_VARIABLE,
    env: { [TOKEN_VARIABLE]: FAKE_TOKEN },
    transport: h.discord.transport,
    now: h.now,
    sleep: async (ms) => h.advance(ms),
    random: () => 0.5,
    os: "macos",
  }
  return {
    ...h,
    run: (extra: Partial<DiscordClientOptions> & { signal?: AbortSignal } = {}) => runSync({ ...options, ...extra }),
    dm(head: string | null, id = SYNC_CHANNEL) {
      h.discord.route("GET", "/users/@me/channels", { status: 200, json: [{ id, type: 1, last_message_id: head }] })
    },
    inspect<T>(fn: (mirror: Mirror) => T): T {
      const mirror = openMirrorForRead(h.paths.mirror)
      try {
        return fn(mirror)
      } finally {
        mirror.close()
      }
    },
    write<T>(fn: (mirror: Mirror) => T): T {
      const mirror = openMirrorForWrite(h.paths.mirror)
      try {
        return inTransaction(mirror, () => fn(mirror))
      } finally {
        mirror.close()
      }
    },
  }
}

export type SyncHarness = Awaited<ReturnType<typeof createSyncHarness>>
