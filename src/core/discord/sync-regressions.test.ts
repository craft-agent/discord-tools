import { afterEach, beforeEach, expect, test } from "bun:test"
import { ingestMessages } from "./ingest"
import { getMeta } from "./mirror"
import { getCursor } from "./mirror-cursors"
import { storedMessageIds } from "./mirror.testing"
import { pendingKey, SYNC_OFFSET_META } from "./sync-status"
import { createSyncHarness, SYNC_CHANNEL, SYNC_ME, syncMessage, syncMessages, type SyncHarness } from "./sync-testing"

let h: SyncHarness
const history = `/channels/${SYNC_CHANNEL}/messages`
beforeEach(async () => {
  h = await createSyncHarness()
})
afterEach(async () => {
  await h.dispose()
})

async function seed() {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 95) })
  expect((await h.run()).status).toBe("complete")
}

test("deleting the newest message reconciles backwards and later stable runs need no history", async () => {
  await seed()
  h.dm("99")
  h.discord.route("GET", history, { status: 200, json: syncMessages(99, 95) })
  expect(await h.run()).toMatchObject({ status: "complete", deleted: 1, requests: 3 })
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "99", oldest: "95", complete: true })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual(["95", "96", "97", "98", "99"])
  for (let run = 0; run < 3; run += 1) expect(await h.run()).toMatchObject({ status: "complete", requests: 2 })
})

test("an empty page for a channel with mirrored history deletes nothing and keeps rows", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "100", oldest: "51", complete: false })

  h.dm(null)
  h.discord.route("GET", history, { status: 200, json: [] })
  expect(await h.run()).toMatchObject({ status: "partial", deleted: 0, requests: 3 })
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "100", oldest: "51", complete: false })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(50)
})

test("a newer message ingested while awaiting latest history survives without false freshness", async () => {
  await seed()
  const synced = h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)
  h.dm("99")
  h.discord.route("GET", history, () => {
    h.write((m) => ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage("101")], { reactions: false }))
    return { status: 200, json: syncMessages(99, 95) }
  })
  expect(await h.run()).toMatchObject({ status: "partial", deleted: 1 })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual(["95", "96", "97", "98", "99", "101"])
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "101", syncedAt: synced })
  h.dm("101")
  h.discord.route("GET", history, { status: 200, json: [syncMessage("101"), ...syncMessages(99, 95)] })
  // A concurrent head is stored but its gap has not been vouched for yet.
  expect(await h.run()).toMatchObject({ status: "complete", requests: 3 })
})

test("a concurrent head cannot become the next run's catch-up anchor before its gap is filled", async () => {
  await seed()
  h.dm("99")
  h.discord.route("GET", history, () => {
    h.write((m) => ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage("400")], { reactions: false }))
    return { status: 200, json: syncMessages(99, 95) }
  })
  expect((await h.run()).status).toBe("partial")
  h.dm("400")
  h.discord.route("GET", history, (request) => {
    const top = request.query.has("before") ? Number(request.query.get("before")) - 1 : 400
    return { status: 200, json: top === 100 ? syncMessages(99, 95) : syncMessages(top, top - 99) }
  })
  expect((await h.run({ budget: 3 })).status).toBe("partial")
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!))).toEqual({
    anchor: "99",
    newest: "400",
    before: "301",
    marker: "400",
  })
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual(
    [...syncMessages(99, 95).reverse(), ...syncMessages(400, 101).reverse()].map((message) => message.id),
  )
})

test("catch-up from verified empty history can resume to its zero anchor", async () => {
  h.dm(null)
  h.discord.route("GET", history, { status: 200, json: [] })
  expect((await h.run()).status).toBe("complete")
  h.dm("200")
  h.discord.route("GET", history, (request) => {
    const top = request.query.has("before") ? Number(request.query.get("before")) - 1 : 200
    return { status: 200, json: top === 0 ? [] : syncMessages(top, top - 99) }
  })
  expect((await h.run({ budget: 3 })).status).toBe("partial")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBeNull()
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!).anchor)).toBe("0")
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(200)
})

test("a live-ingested head known before dispatch is included in authoritative pruning", async () => {
  await seed()
  h.write((m) => ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage("101")], { reactions: false }))
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 95) })
  expect(await h.run()).toMatchObject({ status: "complete", deleted: 1, requests: 3 })
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe("100")
})

test("incomplete catch-up preserves its anchor and continuation never stamps a concurrent newer head", async () => {
  await seed()
  const synced = h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)
  h.dm("300")
  h.discord.route("GET", history, { status: 200, json: syncMessages(300, 201) })
  expect((await h.run({ budget: 3 })).status).toBe("partial")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "100", oldest: "95", syncedAt: synced })
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!).anchor)).toBe("100")
  h.discord.route("GET", history, (request) => {
    expect(request.query.get("before")).toBe("201")
    h.write((m) => ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage("301")], { reactions: false }))
    return { status: 200, json: [] }
  })
  expect((await h.run()).status).toBe("partial")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "301", oldest: "95", syncedAt: synced })
  expect(h.inspect((m) => getMeta(m)[pendingKey(SYNC_CHANNEL)])).toBeUndefined()
})

test("round-robin reaches a changed healthy channel behind sixty permanently forbidden channels", async () => {
  await seed()
  const denied = Array.from({ length: 60 }, (_, i) => ({ id: String(3001 + i), type: 1, last_message_id: "50" }))
  h.discord.route("GET", "/users/@me/channels", {
    status: 200,
    json: [...denied, { id: SYNC_CHANNEL, type: 1, last_message_id: "101" }],
  })
  for (const channel of denied) h.discord.route("GET", `/channels/${channel.id}/messages`, { status: 403, json: {} })
  h.discord.route("GET", history, { status: 200, json: syncMessages(101, 95) })
  const first = await h.run()
  expect(first).toMatchObject({ status: "partial", requests: 60 })
  expect(h.inspect((m) => getMeta(m)[SYNC_OFFSET_META])).toBe("58")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe("100")
  const start = h.discord.api.length
  expect(await h.run()).toMatchObject({ status: "partial", requests: 60 })
  expect(
    h.discord.api
      .slice(start)
      .filter((r) => r.path.endsWith("/messages"))
      .slice(0, 3)
      .map((r) => r.path),
  ).toEqual(["/channels/3059/messages", "/channels/3060/messages", history])
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe("101")
})

test("an unsent budget stop retries that exact channel first and serves all slots in bounded runs", async () => {
  const channels = Array.from({ length: 4 }, (_, i) => ({ id: String(4001 + i), type: 1, last_message_id: "50" }))
  h.discord.route("GET", "/users/@me/channels", { status: 200, json: channels })
  for (const channel of channels) h.discord.route("GET", `/channels/${channel.id}/messages`, { status: 404, json: {} })
  for (let run = 0; run < channels.length; run += 1) {
    const start = h.discord.api.length
    expect(await h.run({ budget: 3 })).toMatchObject({ status: "partial", requests: 3 })
    expect(
      h.discord.api
        .slice(start)
        .filter((r) => r.path.endsWith("/messages"))
        .map((r) => r.path),
    ).toEqual([`/channels/${channels[run]!.id}/messages`])
    expect(h.inspect((m) => getMeta(m)[SYNC_OFFSET_META])).toBe(String((run + 1) % channels.length))
  }
})
