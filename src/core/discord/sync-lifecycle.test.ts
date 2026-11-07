import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BUILD_CACHE_FILE } from "./build-number"
import { ensureLabelDir } from "./labels"
import { getMeta, setMeta } from "./mirror"
import { getCursor } from "./mirror-cursors"
import { ACCOUNT_ID_META } from "./mirror-meta"
import { rowById, storedMessageIds } from "./mirror.testing"
import { acquireSyncLock } from "./sync-lock"
import { pendingKey, SYNC_ERROR_META, SYNC_STATUS_META } from "./sync-status"
import { createSyncHarness, SYNC_CHANNEL, SYNC_ME, syncMessages, type SyncHarness } from "./sync-testing"

let h: SyncHarness
beforeEach(async () => {
  h = await createSyncHarness()
})
afterEach(async () => {
  await h.dispose()
})
const history = `/channels/${SYNC_CHANNEL}/messages`

function assertUnlocked() {
  const release = acquireSyncLock(h.paths.lock)
  expect(release).toBeDefined()
  release?.()
}

test("a busy label returns zero counters, while another label may run", async () => {
  const release = acquireSyncLock(h.paths.lock)!
  try {
    expect(await h.run()).toEqual({ status: "busy", requests: 0, channels: 0, stored: 0, deleted: 0, skipped: 0 })
    expect(h.discord.requests).toHaveLength(0)
    const paths = await ensureLabelDir(h.stateDir, "second")
    expect((await h.run({ paths })).status).toBe("complete")
  } finally {
    release()
  }
  assertUnlocked()
})

test("identity is verified on every run; no account file is created", async () => {
  expect((await h.run()).status).toBe("complete")
  expect((await h.run()).status).toBe("complete")
  expect(h.discord.api.filter((request) => request.path === "/users/@me")).toHaveLength(2)
  expect(h.inspect((m) => getMeta(m)[ACCOUNT_ID_META])).toBe(SYNC_ME)
  expect(existsSync(join(h.paths.dir, "account.json"))).toBe(false)
})

test("account-file mismatch refuses the identity before creating a mirror", async () => {
  await writeFile(join(h.paths.dir, "account.json"), JSON.stringify({ id: "9999", name: "other", verifiedAt: h.now() }))
  await expect(h.run()).rejects.toMatchObject({ code: "unauthenticated" })
  expect(existsSync(h.paths.mirror)).toBe(false)
  expect(h.discord.api.map((request) => request.path)).toEqual(["/users/@me"])
  assertUnlocked()
})

test("a conflicting mirror binding is not overwritten or contaminated", async () => {
  h.write((m) => setMeta(m, { [ACCOUNT_ID_META]: "9999", marker: "keep" }))
  await expect(h.run()).rejects.toMatchObject({ code: "unauthenticated" })
  expect(h.inspect(getMeta)).toEqual({ [ACCOUNT_ID_META]: "9999", marker: "keep" })
  expect(h.inspect((m) => rowById(m, "users", SYNC_ME))).toBeUndefined()
  assertUnlocked()
})

test("malformed identity never initializes the mirror", async () => {
  h.discord.route("GET", "/users/@me", { status: 200, json: { id: SYNC_ME } })
  expect((await h.run()).status).toBe("partial")
  expect(existsSync(h.paths.mirror)).toBe(false)
  assertUnlocked()
})

test("401 stops immediately, persists rejection and prevents the next run's API requests", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 401, json: { message: "sensitive server detail" } })
  await expect(h.run()).rejects.toMatchObject({ code: "unauthenticated" })
  expect(h.inspect((m) => getMeta(m)[SYNC_STATUS_META])).toBe("rejected")
  expect(h.inspect((m) => getMeta(m)[SYNC_ERROR_META])).toBe("unauthenticated")
  const requests = h.discord.requests.length
  await expect(h.run()).rejects.toMatchObject({ code: "unauthenticated" })
  expect(h.discord.requests).toHaveLength(requests)
  assertUnlocked()
})

test("cancellation between pages preserves committed progress, stamps cancelled and releases lock", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  const controller = new AbortController()
  h.dm("400")
  h.discord.route("GET", history, (request) => {
    if (request.query.has("before")) controller.abort()
    return { status: 200, json: request.query.has("before") ? syncMessages(300, 201) : syncMessages(400, 301) }
  })
  await expect(h.run({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(150)
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!).before)).toBe("301")
  expect(h.inspect((m) => getMeta(m)[SYNC_STATUS_META])).toBe("cancelled")
  assertUnlocked()
})

test("pre-aborted runs issue no request and zero budget releases the lock", async () => {
  await expect(h.run({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" })
  expect(h.discord.requests).toHaveLength(0)
  expect(await h.run({ budget: 0 })).toMatchObject({ status: "partial", requests: 0 })
  assertUnlocked()
})

test("the hard cap includes cold build fetch and retries even when the caller grants more", async () => {
  await rm(join(h.stateDir, BUILD_CACHE_FILE))
  const channels = Array.from({ length: 80 }, (_, i) => ({ id: String(2001 + i), type: 1, last_message_id: null }))
  h.discord.route("GET", "/users/@me/channels", { status: 200, json: channels })
  for (const channel of channels) h.discord.route("GET", `/channels/${channel.id}/messages`, { status: 200, json: [] })
  h.discord.route("GET", history, [
    { status: 429, json: { retry_after: 0.1 } },
    { status: 200, json: [] },
  ])
  expect(await h.run({ budget: 1000 })).toMatchObject({ status: "partial", requests: 60 })
  expect(h.discord.requests).toHaveLength(60)
  expect(h.discord.login).toHaveLength(1)
  assertUnlocked()
  expect((await h.run()).status).toBe("complete")
  for (const channel of channels) expect(h.inspect((m) => getCursor(m, channel.id)?.syncedAt)).not.toBeNull()
})

test("rotating attempts prevent permanently forbidden channels from starving later DMs", async () => {
  const channels = Array.from({ length: 80 }, (_, i) => ({ id: String(2001 + i), type: 1, last_message_id: "100" }))
  h.discord.route("GET", "/users/@me/channels", { status: 200, json: channels })
  for (const channel of channels)
    h.discord.route("GET", `/channels/${channel.id}/messages`, { status: 403, json: { message: "no access" } })
  for (let run = 0; run < 3; run += 1) expect((await h.run()).status).toBe("partial")
  const requested = new Set(
    h.discord.api.filter((request) => request.path.endsWith("/messages")).map((request) => request.path),
  )
  expect(requested.size).toBe(80)
  for (const channel of channels) expect(h.inspect((m) => getCursor(m, channel.id))).toBeUndefined()
})
