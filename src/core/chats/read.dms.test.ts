import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestMessages } from "../discord/ingest"
import { getMeta } from "../discord/mirror"
import { CURRENT_MS, markCurrent } from "../discord/mirror-cursors"
import { DM_LIST_AT_META } from "../discord/mirror-meta"
import { columnOf, rowsOf } from "../discord/mirror.testing"
import { ALICE, BOB, DM, messageObject, ME, msgId, userObject } from "../discord/objects.testing"
import { UNTRUSTED_NOTE, idTime } from "./format"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"

const DM_BOB = "1400000000000000301"
const GROUP = "1400000000000000302"
const MINUTE = 60 * 1000

const alice = userObject(ALICE, { username: "alice", global_name: "Alice Liddell" })
const bob = userObject(BOB, { username: "bobby" })

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
})
afterEach(async () => {
  await f.dispose()
})

function channels(...list: unknown[]) {
  f.discord.route("GET", "/users/@me/channels", { status: 200, json: list })
}

function allThree() {
  channels(
    { id: DM, type: 1, recipients: [alice], last_message_id: msgId(10) },
    { id: DM_BOB, type: 1, recipients: [bob], last_message_id: msgId(30) },
    { id: GROUP, type: 3, name: "Trip", recipients: [alice, bob], last_message_id: msgId(20) },
  )
}

const ids = (result: { dms?: { id: string }[] }) => result.dms?.map((dm) => dm.id)

describe("method dms", () => {
  test("reads Discord when no list was stored, newest first, and stores it with a stamp", async () => {
    allThree()
    const started = f.now()
    const result = await f.read({ method: "dms" })
    expect(result.source).toBe("live")
    expect(result.note).toBe(UNTRUSTED_NOTE)
    expect(ids(result)).toEqual([DM_BOB, GROUP, DM])
    expect(result.next_offset).toBeNull()
    expect(result.dms?.[0]).toEqual({
      id: DM_BOB,
      kind: "dm",
      name: null,
      recipients: [{ id: BOB, name: "bobby" }],
      last_message_at: idTime(msgId(30)),
      last: null,
    })
    expect(result.dms?.[1]).toMatchObject({
      kind: "group_dm",
      name: "Trip",
      recipients: [
        { id: ALICE, name: "Alice Liddell" },
        { id: BOB, name: "bobby" },
      ],
    })
    expect(Number(f.inspect((m) => getMeta(m)[DM_LIST_AT_META]))).toBeGreaterThanOrEqual(started)
    expect(f.discord.api).toHaveLength(1)
  })

  test("keeps only DMs and group DMs of the answer", async () => {
    channels({ id: DM, type: 1, recipients: [alice] }, { id: GROUP, type: 5, recipients: [] })
    expect(ids(await f.read({ method: "dms" }))).toEqual([DM])
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM channels"))).toEqual([1])
  })

  test("serves the mirror for under 15 minutes, with no request and no token", async () => {
    allThree()
    await f.read({ method: "dms" })
    f.ctx.runtime!.env = {}
    f.advance(CURRENT_MS - MINUTE)
    const result = await f.read({ method: "dms", limit: 1 })
    expect(result.source).toBe("mirror")
    expect(ids(result)).toEqual([DM_BOB])
    expect(f.discord.api).toHaveLength(1)
  })

  test("reads Discord again when stale, and a closed DM drops out without being deleted", async () => {
    allThree()
    await f.read({ method: "dms" })
    channels({ id: DM, type: 1, recipients: [alice], last_message_id: msgId(10) })
    f.advance(CURRENT_MS + MINUTE)
    const result = await f.read({ method: "dms" })
    expect(result.source).toBe("live")
    expect(ids(result)).toEqual([DM])
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM channels"))).toEqual([3])
    expect(f.discord.api).toHaveLength(2)
  })

  test("query matches names and the usernames and display names of the people, ignoring case", async () => {
    allThree()
    expect(ids(await f.read({ method: "dms", query: "ALICE" }))).toEqual([GROUP, DM])
    expect(ids(await f.read({ method: "dms", query: "liddell" }))).toEqual([GROUP, DM])
    expect(ids(await f.read({ method: "dms", query: "trip" }))).toEqual([GROUP])
    expect(ids(await f.read({ method: "dms", query: "bobb" }))).toEqual([DM_BOB, GROUP])
    const none = await f.read({ method: "dms", query: "nobody" })
    expect(none.dms).toEqual([])
    expect(none.next_offset).toBeNull()
  })

  test("pages with limit, offset and next_offset", async () => {
    allThree()
    const first = await f.read({ method: "dms", limit: 2 })
    expect(ids(first)).toEqual([DM_BOB, GROUP])
    expect(first.next_offset).toBe(2)
    const second = await f.read({ method: "dms", limit: 2, offset: first.next_offset! })
    expect(ids(second)).toEqual([DM])
    expect(second.next_offset).toBeNull()
    expect(ids(await f.read({ method: "dms", limit: 1, offset: 1 }))).toEqual([GROUP])
    expect((await f.read({ method: "dms", limit: 1, offset: 1 })).next_offset).toBe(2)
    expect((await f.read({ method: "dms", offset: 50 })).dms).toEqual([])
  })

  test("shows the newest mirrored message, clipped, and whether it is the user's own", async () => {
    allThree()
    await f.read({ method: "dms" })
    const long = "x".repeat(250)
    f.seed((m) => {
      const ctx = f.ingestContext()
      ingestMessages(m, ctx, [messageObject(msgId(1), DM, { content: "older" })], { reactions: true })
      ingestMessages(m, ctx, [messageObject(msgId(2), DM, { content: "mine", author: userObject(ME) })], {
        reactions: true,
      })
      ingestMessages(m, ctx, [messageObject(msgId(3), GROUP, { content: long, author: alice })], { reactions: true })
    })
    const result = await f.read({ method: "dms" })
    const byId = Object.fromEntries(result.dms!.map((dm) => [dm.id, dm.last]))
    expect(byId[DM]).toEqual({
      id: msgId(2),
      from_me: true,
      author_id: ME,
      author: "user01",
      at: idTime(msgId(2)),
      text: "mine",
    })
    expect(byId[GROUP]).toMatchObject({ from_me: false, author_id: ALICE, author: "Alice Liddell" })
    expect(byId[GROUP]?.text).toBe(`${"x".repeat(200)}…`)
    expect(byId[DM_BOB]).toBeNull()
  })

  test("reading marks nothing current", async () => {
    allThree()
    f.seed((m) => markCurrent(m, DM, 123))
    await f.read({ method: "dms" })
    f.advance(CURRENT_MS + MINUTE)
    await f.read({ method: "dms" })
    expect(f.inspect((m) => rowsOf(m, "SELECT CAST(channel AS TEXT) AS channel, synced_at FROM cursors"))).toEqual([
      { channel: DM, synced_at: 123 },
    ])
  })

  test("a malformed answer is an upstream error and stores nothing", async () => {
    f.discord.route("GET", "/users/@me/channels", { status: 200, json: { message: "oops" } })
    expect((await failure(f.read({ method: "dms" }))).code).toBe("upstream_error")
    channels({ id: DM, type: 1, guild_id: "1400000000000000100" })
    expect((await failure(f.read({ method: "dms" }))).code).toBe("upstream_error")
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM channels"))).toEqual([0])
    expect(f.inspect((m) => getMeta(m)[DM_LIST_AT_META])).toBeUndefined()
  })
})
