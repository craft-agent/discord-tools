import { afterEach, beforeEach, expect, test } from "bun:test"
import { getMeta, setMeta } from "./mirror"
import { getCursor } from "./mirror-cursors"
import { storedMessageIds } from "./mirror.testing"
import { snowflakeAt } from "./snowflake"
import { coveredHeadKey, pendingKey, verifiedMarkerKey } from "./sync-status"
import { createSyncHarness, SYNC_CHANNEL, syncMessage, syncMessages, type SyncHarness } from "./sync-testing"

let h: SyncHarness
const history = `/channels/${SYNC_CHANNEL}/messages`
const markerKey = verifiedMarkerKey(SYNC_CHANNEL)
beforeEach(async () => {
  h = await createSyncHarness()
})
afterEach(async () => {
  await h.dispose()
})

async function recentSeed() {
  const base = BigInt(snowflakeAt(h.now() - 60_000))
  const messages = Array.from({ length: 6 }, (_, i) => syncMessage(String(base + BigInt(100 - i))))
  h.dm(messages[0]!.id)
  h.discord.route("GET", history, { status: 200, json: messages })
  expect((await h.run()).status).toBe("complete")
  return messages
}

async function pendingWithDeletedMarker() {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 95) })
  await h.run()
  h.dm("301")
  h.discord.route("GET", history, (request) => {
    const top = request.query.has("before") ? Number(request.query.get("before")) - 1 : 300
    return { status: 200, json: syncMessages(top, Math.max(95, top - 99)) }
  })
  expect((await h.run({ budget: 3 })).status).toBe("partial")
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("100")
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!).marker)).toBe("301")
}

test("a deleted last-sent marker completes, skips unchanged history, and remains eligible for later rechecks", async () => {
  const messages = await recentSeed()
  h.advance(31 * 60_000)
  h.discord.route("GET", history, { status: 200, json: messages.slice(1) })
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3, deleted: 1 })
  expect(h.discord.api.at(-1)?.query.get("limit")).toBe("50")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe(messages[1]!.id)
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe(messages[0]!.id)
  expect(h.inspect((m) => getMeta(m)[coveredHeadKey(SYNC_CHANNEL)])).toBe(messages[1]!.id)
  expect(await h.run()).toMatchObject({ status: "complete", requests: 2 })
  h.advance(31 * 60_000)
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3 })
  expect(h.discord.api.at(-1)?.query.get("limit")).toBe("50")
})

test("deleting all messages while retaining the last-sent marker completes and then avoids refetching", async () => {
  const messages = await recentSeed()
  h.advance(31 * 60_000)
  h.discord.route("GET", history, { status: 200, json: [] })
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3, deleted: 6 })
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: null, oldest: null, complete: true })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual([])
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe(messages[0]!.id)
  expect(h.inspect((m) => getMeta(m)[coveredHeadKey(SYNC_CHANNEL)])).toBe("0")
  expect(await h.run()).toMatchObject({ status: "complete", requests: 2 })
  h.advance(31 * 60_000)
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3 })
})

test("a continuation with the same deleted marker completes despite its older surviving head", async () => {
  await pendingWithDeletedMarker()
  expect(await h.run()).toMatchObject({ status: "complete", requests: 4 })
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe("300")
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("301")
  expect(await h.run()).toMatchObject({ status: "complete", requests: 2 })
})

test("a continuation cannot verify a different marker observed on a later run", async () => {
  await pendingWithDeletedMarker()
  const synced = h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)
  h.dm("302")
  expect((await h.run()).status).toBe("partial")
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("301")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)).toBe(synced)
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3 })
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("302")
})

test("legacy pending progress uses its saved actual head, never the newly observed marker", async () => {
  await pendingWithDeletedMarker()
  h.write((m) => {
    const pending = JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!)
    delete pending.marker
    setMeta(m, { [pendingKey(SYNC_CHANNEL)]: JSON.stringify(pending) })
  })
  expect((await h.run()).status).toBe("partial")
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("300")
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3 })
})

test("an explicit null pending marker stays null rather than falling back to the saved head", async () => {
  await pendingWithDeletedMarker()
  h.write((m) => {
    const pending = JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!)
    setMeta(m, { [pendingKey(SYNC_CHANNEL)]: JSON.stringify({ ...pending, marker: null }) })
  })
  h.dm(null)
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("0")
  expect(await h.run()).toMatchObject({ status: "complete", requests: 2 })
})

test("invalid pending markers are refused before history or freshness is changed", async () => {
  await pendingWithDeletedMarker()
  const cursor = h.inspect((m) => getCursor(m, SYNC_CHANNEL))
  for (const marker of [42, true, "name", {}]) {
    h.write((m) => {
      const pending = JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!)
      setMeta(m, { [pendingKey(SYNC_CHANNEL)]: JSON.stringify({ ...pending, marker }) })
    })
    expect(await h.run()).toMatchObject({ status: "partial", requests: 2 })
    expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toEqual(cursor)
    expect(h.inspect((m) => getMeta(m)[markerKey])).toBe("100")
  }
})

test("unknown metadata is never recorded as a verified marker or treated as unchanged", async () => {
  h.discord.route("GET", "/users/@me/channels", { status: 200, json: [{ id: SYNC_CHANNEL, type: 1 }] })
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 95) })
  for (let run = 0; run < 2; run += 1) {
    expect(await h.run()).toMatchObject({ status: "partial", requests: 3 })
    expect(h.inspect((m) => getMeta(m)[markerKey])).toBeUndefined()
    expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)).toBeNull()
  }
})

test("mirrors without verified-marker metadata retain the conservative legacy unchanged check", async () => {
  await recentSeed()
  h.write((m) => setMeta(m, { [markerKey]: null, [coveredHeadKey(SYNC_CHANNEL)]: null }))
  expect(await h.run()).toMatchObject({ status: "complete", requests: 2 })
})
