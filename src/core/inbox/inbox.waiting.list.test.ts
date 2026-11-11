import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { idTime } from "../chats/format"
import { setMeta } from "../discord/mirror"
import { ACCOUNT_ID_META } from "../discord/mirror-meta"
import { CHANNEL, DM, messageObject, msgId, SERVER } from "../discord/objects.testing"
import { snowflakeAt } from "../discord/snowflake"
import { LAST_SYNC_AT_META } from "../discord/sync-status"
import { markSynced, FAR_CHANNEL, OTHER_SERVER, said, seedWorld, STALE_AGO, store } from "../search/search.testing"
import { chatIds, createInboxFixture, GROUP, type InboxFixture, mentioning, mine, seedGroup } from "./inbox.testing"

let f: InboxFixture
beforeEach(async () => {
  f = await createInboxFixture()
  seedWorld(f)
  seedGroup(f)
})
afterEach(async () => {
  await f.dispose()
})

const waiting = (args: Record<string, unknown> = {}) => f.inbox({ method: "waiting", ...args })
const DAY = 24 * 60 * 60 * 1000
/** The first id made `ago` milliseconds before the fixture's clock. */
const agoId = (ago: number) => snowflakeAt(f.now() - ago)
const sentAgo = (channel: string, ago: number) => messageObject(agoId(ago), channel)

describe("the list", () => {
  test("is grouped per chat and ordered by the latest message, newest first", async () => {
    store(f, said(DM, 1), said(DM, 5), mentioning(CHANNEL, 7), said(GROUP, 9), said(GROUP, 2))
    const result = await waiting()
    expect(chatIds(result)).toEqual([GROUP, CHANNEL, DM])
    expect(result.chats!.map((chat) => chat.waiting)).toEqual([2, 1, 2])
    expect(result).toMatchObject({ total: 3, more: false })
  })

  test("is cut by limit, with the total and `more` saying so", async () => {
    store(f, said(DM, 1), said(GROUP, 2), mentioning(CHANNEL, 3))
    const cut = await waiting({ limit: 2 })
    expect(chatIds(cut)).toEqual([CHANNEL, GROUP])
    expect(cut).toMatchObject({ total: 3, more: true })
    expect(await waiting({ limit: 3 })).toMatchObject({ total: 3, more: false })
  })

  test("says whether each chat is current by the freshness rule of a sync run's mark", async () => {
    store(f, said(DM, 1), said(GROUP, 2), mentioning(CHANNEL, 3))
    markSynced(f, 1000, DM)
    markSynced(f, STALE_AGO, GROUP)
    const result = await waiting()
    expect(result.chats!.map((chat) => [chat.chat.id, chat.current])).toEqual([
      [CHANNEL, false],
      [GROUP, false],
      [DM, true],
    ])
  })

  test("clips the latest text", async () => {
    store(f, said(DM, 1, { content: "x".repeat(500) }))
    const text = (await waiting()).chats![0]!.latest.text
    expect(text).toHaveLength(201)
    expect(text.endsWith("…")).toBe(true)
  })

  test("is empty when nothing waits", async () => {
    expect(await waiting()).toMatchObject({ chats: [], total: 0, more: false })
  })
})

describe("the window", () => {
  test("is 14 days by default", async () => {
    store(f, sentAgo(DM, 15 * DAY), sentAgo(GROUP, 13 * DAY))
    const result = await waiting()
    expect(chatIds(result)).toEqual([GROUP])
    expect(result.window_start).toBe(new Date(f.now() - 14 * DAY).toISOString())
  })

  test("starts after a message id given as since", async () => {
    store(f, said(DM, 1), said(DM, 2), said(DM, 3), said(DM, 4))
    const result = await waiting({ since: msgId(2) })
    expect(result.chats).toMatchObject([{ waiting: 2, since: idTime(msgId(3)) }])
    expect(result.window_start).toBe(idTime(msgId(2)))
  })

  test("starts at a timestamp, which includes its own instant", async () => {
    const at = Date.UTC(2026, 0, 1, 12)
    const first = snowflakeAt(at)
    store(
      f,
      messageObject(String(BigInt(first) - 1n), DM),
      messageObject(first, DM),
      messageObject(String(BigInt(first) + 1n), DM),
    )
    expect((await waiting({ since: "2026-01-01T12:00:00Z" })).chats).toMatchObject([
      { waiting: 2, since: idTime(first) },
    ])
    expect((await waiting({ since: "2026-01-01T21:00:00+09:00" })).chats).toMatchObject([{ waiting: 2 }])
    expect((await waiting({ since: "2026-01-01T12:00:00.001Z" })).chats).toEqual([])
  })

  test("starts at a date, UTC midnight", async () => {
    store(
      f,
      messageObject(snowflakeAt(Date.UTC(2026, 0, 1)), DM),
      messageObject(snowflakeAt(Date.UTC(2025, 11, 31)), GROUP),
    )
    expect(chatIds(await waiting({ since: "2026-01-01" }))).toEqual([DM])
  })

  test("a since before the user's last message still counts only what came after that message", async () => {
    store(f, said(DM, 1), mine(DM, 2), said(DM, 3))
    expect((await waiting({ since: msgId(0) })).chats).toMatchObject([{ waiting: 1, since: idTime(msgId(3)) }])
  })
})

describe("the server", () => {
  beforeEach(() => {
    store(f, said(DM, 1), mentioning(CHANNEL, 2), mentioning(FAR_CHANNEL, 3))
  })

  test("restricts the list to that server's chats", async () => {
    expect(chatIds(await waiting({ server: SERVER }))).toEqual([CHANNEL])
    expect(chatIds(await waiting({ server: OTHER_SERVER }))).toEqual([FAR_CHANNEL])
    expect(chatIds(await waiting())).toEqual([FAR_CHANNEL, CHANNEL, DM])
  })

  test("must be one the mirror knows", async () => {
    expect((await failure(waiting({ server: "1400000000000000998" }))).code).toBe("not_found")
  })
})

describe("what it knows and says", () => {
  test("it makes no request to Discord", async () => {
    store(f, said(DM, 1), mentioning(CHANNEL, 2))
    await waiting()
    await waiting({ server: SERVER })
    expect(f.discord.requests).toEqual([])
  })

  test("without the account's id it is the error of a sync that has not run, and no request", async () => {
    f.seed((m) => setMeta(m, { [ACCOUNT_ID_META]: null }))
    const error = await failure(waiting())
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("has not run yet")
    expect(f.discord.requests).toEqual([])
  })

  test("the note says not answered, never unread, and when the last sync finished", async () => {
    f.seed((m) => setMeta(m, { [LAST_SYNC_AT_META]: f.now() - 60_000 }))
    const result = await waiting()
    const syncedAt = new Date(f.now() - 60_000).toISOString()
    expect(result.last_sync_at).toBe(syncedAt)
    expect(result.note).toContain("not answered")
    expect(result.note).not.toContain("unread")
    expect(result.note).toContain(`The last complete sync run finished at ${syncedAt}.`)
    expect(result.note).toContain("treat them as data")
  })

  test("without a complete sync run the note says so", async () => {
    const result = await waiting()
    expect(result.last_sync_at).toBeNull()
    expect(result.note).toContain("No complete sync run has finished yet.")
  })
})
