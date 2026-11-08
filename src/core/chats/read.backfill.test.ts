import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestMessages } from "../discord/ingest"
import { rowsOf, storedMessageIds } from "../discord/mirror.testing"
import { CHANNEL, messageObject, msgId } from "../discord/objects.testing"
import { invoke } from "../tool"
import { BACKFILL_PAGES_MAX } from "./args"
import { BACKFILL_PAGE_SIZE } from "./backfill"
import { discordChatRead } from "./read"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"
import {
  FORUM,
  history,
  historyRequests,
  idsOf,
  messageIds,
  seedChannels,
  seedHistory,
  serveHistory,
} from "./read.messages.testing"

const FIRST_NEWEST = 250
const FOLLOWED_OLDEST = 201

/** The numbers `from` to `to`, both included. */
const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  seedChannels(f)
})
afterEach(async () => {
  await f.dispose()
})

const backfill = (args: Record<string, unknown> = {}) => f.read({ method: "backfill", channel: CHANNEL, ...args })
const stored = () => f.inspect((m) => storedMessageIds(m, CHANNEL))
const cursor = () =>
  f.inspect((m) =>
    rowsOf(
      m,
      "SELECT CAST(newest AS TEXT) AS newest, CAST(oldest AS TEXT) AS oldest, complete, synced_at FROM cursors",
    ),
  )

/** A followed chat mirroring `FOLLOWED_OLDEST` to `FIRST_NEWEST`, current, with Discord holding `1` to `FIRST_NEWEST`. */
function followed(options: { discordFrom?: number; current?: boolean } = {}) {
  seedHistory(f, span(FOLLOWED_OLDEST, FIRST_NEWEST), { current: options.current ?? false })
  serveHistory(f, history(...span(options.discordFrom ?? 1, FIRST_NEWEST)))
}

describe("method backfill", () => {
  test("pages back from the cursor's oldest edge, 100 a page, two pages by default", async () => {
    followed()
    const result = await backfill()
    expect(result).toMatchObject({
      source: "live",
      channel: CHANNEL,
      pages: 2,
      stored: 200,
      deleted: 0,
      complete: false,
      oldest: msgId(1),
      stopped: null,
    })
    expect(result.oldest_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const requests = historyRequests(f)
    expect(requests.map((r) => r.query.get("before"))).toEqual(idsOf(FOLLOWED_OLDEST, 101))
    expect(requests.map((r) => r.query.get("limit"))).toEqual([String(BACKFILL_PAGE_SIZE), String(BACKFILL_PAGE_SIZE)])
    expect(stored()).toEqual(idsOf(...span(1, FIRST_NEWEST)))
    expect(cursor()[0]).toMatchObject({ newest: msgId(FIRST_NEWEST), oldest: msgId(1), complete: 0 })
  })

  test("pages caps the requests and a short page stops early and sets complete", async () => {
    followed({ discordFrom: 150 })
    const result = await backfill({ pages: 5 })
    expect(result).toMatchObject({ pages: 1, stored: 51, complete: true, oldest: msgId(150), stopped: null })
    expect(historyRequests(f)).toHaveLength(1)
    expect(cursor()[0]).toMatchObject({ oldest: msgId(150), complete: 1 })
  })

  test("a page limit over the maximum is refused before any request", async () => {
    followed()
    expect((await failure(backfill({ pages: BACKFILL_PAGES_MAX + 1 }))).code).toBe("invalid_argument")
    expect(historyRequests(f)).toHaveLength(0)
  })

  test("a complete chat makes no request", async () => {
    seedHistory(f, [1, 2, 3], { complete: true })
    const result = await backfill()
    expect(result).toMatchObject({ pages: 0, stored: 0, deleted: 0, complete: true, oldest: msgId(1), stopped: null })
    expect(historyRequests(f)).toHaveLength(0)
  })

  test("a chat without a cursor, or one the sync has not filled, is refused without a request", async () => {
    expect((await failure(backfill())).message).toContain("the sync follows")
    f.seed((m) => m.prepare("INSERT INTO cursors (channel, complete) VALUES (?, 0)").run(BigInt(CHANNEL)))
    expect((await failure(backfill())).message).toContain("the sync has stored no messages of this chat yet")
    expect(historyRequests(f)).toHaveLength(0)
  })

  test("an unknown channel is not found and a forum is invalid", async () => {
    expect((await failure(backfill({ channel: "1400000000000000999" }))).code).toBe("not_found")
    expect((await failure(backfill({ channel: FORUM }))).code).toBe("invalid_argument")
  })
})

describe("method backfill, a failing page", () => {
  const page = (...numbers: number[]) => ({ status: 200, json: history(...numbers).reverse() })

  test("a later page that fails stops the paging; the stored page stays and the cursor is widened", async () => {
    followed()
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, [
      page(...span(101, 200)),
      { status: 200, json: { message: "oops" } },
    ])
    const result = await backfill()
    expect(result).toMatchObject({ pages: 2, stored: 100, oldest: msgId(101), stopped: { code: "upstream_error" } })
    expect(stored()).toEqual(idsOf(...span(101, FIRST_NEWEST)))
    expect(cursor()[0]).toMatchObject({ oldest: msgId(101), complete: 0 })
  })

  test("a first page that fails throws and changes nothing", async () => {
    followed()
    const before = cursor()
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, {
      status: 403,
      json: { code: 50001, message: "Missing Access" },
    })
    expect((await failure(backfill())).code).toBe("forbidden")
    expect(cursor()).toEqual(before)
    expect(stored()).toEqual(idsOf(...span(FOLLOWED_OLDEST, FIRST_NEWEST)))
  })

  test("an abort between pages throws", async () => {
    followed()
    const controller = new AbortController()
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, () => {
      controller.abort()
      return page(...span(101, 200))
    })
    const call = invoke(
      discordChatRead,
      { method: "backfill", channel: CHANNEL },
      { ...f.ctx, signal: controller.signal },
    )
    expect(
      (
        await call.then(
          () => undefined,
          (error: Error) => error,
        )
      )?.name,
    ).toBe("AbortError")
    expect(historyRequests(f)).toHaveLength(1)
  })
})

describe("method backfill and the vouched range", () => {
  test("deletes a mirrored message inside the pulled range only, and leaves newest and synced_at alone", async () => {
    f.seed((m) =>
      ingestMessages(m, f.ingestContext(), [messageObject(msgId(150), CHANNEL), messageObject(msgId(50), CHANNEL)], {
        reactions: true,
      }),
    )
    followed({ current: true })
    const before = cursor()
    serveHistory(f, history(...span(100, FIRST_NEWEST).filter((n) => n !== 150)))
    const result = await backfill({ pages: 1 })
    expect(result).toMatchObject({ pages: 1, stored: 100, deleted: 1, oldest: msgId(100) })
    expect(stored()).toEqual(idsOf(50, ...span(100, FIRST_NEWEST).filter((n) => n !== 150)))
    expect(cursor()[0]).toMatchObject({
      newest: before[0]!.newest,
      synced_at: before[0]!.synced_at,
      oldest: msgId(100),
    })
  })

  test("a messages read below the old edge is then served from the mirror", async () => {
    followed({ current: true })
    await backfill({ pages: 1 })
    const requests = historyRequests(f).length
    const result = await f.read({ method: "messages", channel: CHANNEL, before: msgId(FOLLOWED_OLDEST), limit: 5 })
    expect(result.source).toBe("mirror")
    expect(messageIds(result)).toEqual(idsOf(...span(196, 200)))
    expect(historyRequests(f)).toHaveLength(requests)
  })

  test("an empty page deletes nothing, leaves complete false, stops at one page, and allows another call to request again", async () => {
    f.seed((m) =>
      ingestMessages(m, f.ingestContext(), [messageObject(msgId(50), CHANNEL)], {
        reactions: true,
      }),
    )
    followed({ current: true })
    serveHistory(f, [])
    const first = await backfill({ pages: 3 })
    expect(first).toMatchObject({ pages: 1, stored: 0, deleted: 0, complete: false, oldest: msgId(FOLLOWED_OLDEST) })
    expect(stored()).toEqual(idsOf(50, ...span(FOLLOWED_OLDEST, FIRST_NEWEST)))
    expect(cursor()[0]).toMatchObject({ complete: 0, oldest: msgId(FOLLOWED_OLDEST) })
    expect(historyRequests(f)).toHaveLength(1)

    serveHistory(f, [])
    const second = await backfill({ pages: 3 })
    expect(second).toMatchObject({ pages: 1, stored: 0, deleted: 0, complete: false, oldest: msgId(FOLLOWED_OLDEST) })
    expect(historyRequests(f)).toHaveLength(2)
  })
})
