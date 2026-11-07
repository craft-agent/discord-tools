import { afterEach, beforeEach, expect, test } from "bun:test"
import { ingestMessages } from "./ingest"
import { getMeta } from "./mirror"
import { getCursor } from "./mirror-cursors"
import { rowById, storedMessageIds } from "./mirror.testing"
import { snowflakeAt } from "./snowflake"
import { pendingKey } from "./sync-status"
import { createSyncHarness, SYNC_CHANNEL, SYNC_ME, syncMessage, syncMessages, type SyncHarness } from "./sync-testing"

let h: SyncHarness
beforeEach(async () => {
  h = await createSyncHarness()
})
afterEach(async () => {
  await h.dispose()
})
const history = `/channels/${SYNC_CHANNEL}/messages`

test("recent unchanged channels recheck edits and deletions in an exclusive bounded range", async () => {
  const base = BigInt(snowflakeAt(h.now() - 60_000))
  const id = (offset: number) => String(base + BigInt(offset))
  const messages = (top: number, bottom: number) =>
    Array.from({ length: top - bottom + 1 }, (_, i) => syncMessage(id(top - i)))
  h.dm(id(200))
  h.discord.route("GET", history, { status: 200, json: messages(200, 151) })
  await h.run()
  h.write((m) =>
    ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage(id(149)), syncMessage("42", "9999")], {
      reactions: false,
    }),
  )
  h.advance(31 * 60_000)
  const updated = messages(200, 150).filter((message) => message.id !== id(175))
  updated[0]!.content = "edited"
  h.discord.route("GET", history, { status: 200, json: updated })
  expect(await h.run()).toMatchObject({ status: "complete", deleted: 1 })
  expect(h.discord.api.at(-1)?.query.get("limit")).toBe("50")
  expect(h.inspect((m) => rowById(m, "messages", id(200))?.content)).toBe("edited")
  expect(h.inspect((m) => rowById(m, "messages", id(175)))).toBeUndefined()
  expect(h.inspect((m) => rowById(m, "messages", id(149)))).toBeDefined()
  expect(h.inspect((m) => storedMessageIds(m, "9999"))).toEqual(["42"])
  const count = h.discord.api.length
  await h.run()
  expect(h.discord.api.slice(count).some((request) => request.path === history)).toBe(false)
})

test("only two due channels are rechecked, with the remaining channel served next run", async () => {
  const ids = ["2001", "2002", "2003"]
  const newest = (index: number) => String(BigInt(snowflakeAt(h.now() - 60_000)) + BigInt(index))
  const channels = ids.map((id, index) => ({ id, type: 3, last_message_id: newest(index) }))
  h.discord.route("GET", "/users/@me/channels", {
    status: 200,
    json: channels,
  })
  for (const channel of channels)
    h.discord.route("GET", `/channels/${channel.id}/messages`, {
      status: 200,
      json: [syncMessage(channel.last_message_id, channel.id)],
    })
  await h.run()
  h.advance(31 * 60_000)
  const start = h.discord.api.length
  expect((await h.run()).status).toBe("complete")
  expect(h.discord.api.slice(start).filter((request) => request.path.endsWith("/messages"))).toHaveLength(2)
  const next = h.discord.api.length
  expect((await h.run()).status).toBe("complete")
  expect(h.discord.api.slice(next).filter((request) => request.path.endsWith("/messages"))).toHaveLength(1)
})

test("empty latest history removes only the observed range and never falsely stamps a deleted cursor head", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 95) })
  await h.run()
  const synced = h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)
  h.dm(null)
  h.discord.route("GET", history, () => {
    h.write((m) => ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage("200")], { reactions: false }))
    return { status: 200, json: [] }
  })
  expect(await h.run()).toMatchObject({ status: "partial", deleted: 6, requests: 3 })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual(["200"])
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.syncedAt)).toBe(synced)
})

test("a failed progress write rolls back its entire history page", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  h.write((m) =>
    m.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON meta
    WHEN NEW.key = '${pendingKey(SYNC_CHANNEL)}' BEGIN SELECT RAISE(ABORT, 'test progress failure'); END`),
  )
  h.dm("400")
  h.discord.route("GET", history, { status: 200, json: syncMessages(400, 301) })
  await expect(h.run()).rejects.toThrow("test progress failure")
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toHaveLength(50)
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL)?.newest)).toBe("100")
  expect(h.inspect((m) => getMeta(m)[pendingKey(SYNC_CHANNEL)])).toBeUndefined()
})

test("a catch-up keeps an incomplete cursor's oldest above a message a live read stored below it", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  h.write((m) => ingestMessages(m, { me: SYNC_ME, now: h.now() }, [syncMessage("10")], { reactions: false }))
  h.dm("199")
  h.discord.route("GET", history, { status: 200, json: syncMessages(199, 100) })
  expect((await h.run()).status).toBe("complete")
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "199", oldest: "51", complete: false })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toContain("10")
})

test("a short continuation proves the start and prunes deleted messages up to the sent before boundary", async () => {
  h.dm("100")
  h.discord.route("GET", history, { status: 200, json: syncMessages(100, 51) })
  await h.run()
  h.dm("300")
  h.discord.route("GET", history, (request) => ({
    status: 200,
    json: request.query.has("before") ? [] : syncMessages(300, 201),
  }))
  expect(await h.run()).toMatchObject({ status: "complete", deleted: 50 })
  expect(h.inspect((m) => storedMessageIds(m, SYNC_CHANNEL))).toEqual(
    syncMessages(300, 201)
      .map((m) => m.id)
      .reverse(),
  )
  expect(h.inspect((m) => getCursor(m, SYNC_CHANNEL))).toMatchObject({ newest: "300", complete: true })
})
