import { afterEach, beforeEach, expect, test } from "bun:test"
import { getMeta } from "./mirror"
import { getCursor } from "./mirror-cursors"
import { storedMessageIds, rowById } from "./mirror.testing"
import { LAST_SYNC_AT_META, pendingKey, SYNC_STATUS_META } from "./sync-status"
import { createSyncHarness, SYNC_CHANNEL, syncMessages, type SyncHarness } from "./sync-testing"

let h: SyncHarness
beforeEach(async () => {
  h = await createSyncHarness()
})
afterEach(async () => {
  await h.dispose()
})
const history = `/channels/${SYNC_CHANNEL}/messages`

test("seeds only the newest 50 and unchanged metadata makes no history request", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  expect((await h.run()).status).toBe("complete")
  expect(h.discord.api.find((request) => request.path === history)?.query.get("limit")).toBe("50")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "100", oldest: "51", complete: false })
  const count = h.discord.api.filter((request) => request.path === history).length
  expect((await h.run()).status).toBe("complete")
  expect(h.discord.api.filter((request) => request.path === history).length).toBe(count)
})

test("a truly empty channel becomes current without marking complete, then short seed reaches the start", async () => {
  h.dm(null)
  h.discord.route("GET", history, { status: 200, json: [] })
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: null, oldest: null, complete: false })
  h.dm("10")
  h.discord.route("GET", history, { status: 200, json: syncMessages(10, 1) })
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(10)
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "10", oldest: "1", complete: true })
})

test("budget cut commits page and pending progress together, then resumes before the saved boundary", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  const last = h.inspect((m) => getMeta(m)[LAST_SYNC_AT_META])
  const synced = h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)
  h.dm("350")
  h.discord.route("GET", history, (request) => {
    const top = request.query.has("before") ? Number(request.query.get("before")) - 1 : 350
    return { status: 200, json: syncMessages(top, Math.max(1, top - 99)) }
  })
  expect(await h.run({ budget: 3 })).toMatchObject({ status: "partial", requests: 3 })
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "100", oldest: "51", syncedAt: synced })
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!))).toEqual({
    anchor: "100",
    newest: "350",
    before: "251",
    marker: "350",
  })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(150)
  expect(h.inspect((m) => getMeta(m)[LAST_SYNC_AT_META])).toBe(last)
  const start = h.discord.api.length
  expect((await h.run()).status).toBe("complete")
  expect(
    h.discord.api
      .slice(start)
      .filter((r) => r.path === history)
      .map((r) => r.query.get("before")),
  ).toEqual(["251", "151"])
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual(
    syncMessages(350, 51)
      .map((m) => m.id)
      .reverse(),
  )
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "350", oldest: "51" })
  expect(h.inspect((m) => getMeta(m)[pendingKey(SYNC_CHANNEL)])).toBeUndefined()
})

test("five-page limit progresses over repeated runs and a moved head remains stale", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  h.dm("1000")
  h.discord.route("GET", history, (request) => {
    const top = request.query.has("before") ? Number(request.query.get("before")) - 1 : 1000
    return { status: 200, json: syncMessages(top, top - 99) }
  })
  expect(await h.run()).toMatchObject({ status: "partial", requests: 7 })
  expect(h.inspect((m) => JSON.parse(getMeta(m)[pendingKey(SYNC_CHANNEL)]!).before)).toBe("501")
  h.dm("1001")
  expect((await h.run()).status).toBe("partial")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe("1000")
  expect(h.inspect((m) => getMeta(m)[pendingKey(SYNC_CHANNEL)])).toBeUndefined()
  h.discord.route("GET", history, { status: 200, json: syncMessages(1001, 902) })
  expect((await h.run()).status).toBe("complete")
})

test("malformed and foreign pages neither prune nor advance freshness", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  const before = h.inspect((m) => getCursor(m, SYNC_CHANNEL))
  h.dm("101")
  for (const response of [
    { messages: syncMessages(101, 95) },
    [{ id: "101", channel_id: "9999", content: "foreign" }],
    [{ id: "101", channel_id: SYNC_CHANNEL, content: 42 }],
    [...syncMessages(101, 100), ...syncMessages(101, 100)],
  ]) {
    h.discord.route("GET", history, { status: 200, json: response })
    expect((await h.run()).status).toBe("partial")
    expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toEqual(before)
    expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(50)
    expect(h.inspect((m) => rowById(m, "messages", "101"))).toBeUndefined()
  }
})

test("a response outside a pending before boundary leaves its committed progress intact", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  h.dm("400")
  h.discord.route("GET", history, { status: 200, json: syncMessages(400, 301) })
  await h.run({ budget: 3 })
  const pending = h.inspect((m) => getMeta(m)[pendingKey(SYNC_CHANNEL)])
  expect((await h.run()).status).toBe("partial")
  expect(h.inspect((m) => getMeta(m)[pendingKey(SYNC_CHANNEL)])).toBe(pending)
  expect(h.inspect((m) => getMeta(m)[SYNC_STATUS_META])).toBe("partial")
})
