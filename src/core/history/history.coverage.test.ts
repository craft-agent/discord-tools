import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHANNEL, DM, OTHER_CHANNEL } from "../discord/objects.testing"
import { setCursorEdges } from "../discord/mirror-cursors"
import { snowflakeAt } from "../discord/snowflake"
import { markSynced, seedWorld, STALE_AGO, store } from "../search/search.testing"
import { createHistoryFixture, DAY_MS, type HistoryFixture, sentAt } from "./history.testing"

let f: HistoryFixture
beforeEach(async () => {
  f = await createHistoryFixture()
  seedWorld(f)
  store(
    f,
    sentAt(CHANNEL, f.now() - DAY_MS),
    sentAt(OTHER_CHANNEL, f.now() - DAY_MS, 1),
    sentAt(DM, f.now() - DAY_MS, 2),
  )
})
afterEach(async () => {
  await f.dispose()
})

/** The cursor of `channel` reaching back to `days` days before the fixture's clock. */
const reachingBack = (channel: string, days: number, complete = false) =>
  f.seed((m) =>
    setCursorEdges(m, channel, {
      oldest: snowflakeAt(f.now() - days * DAY_MS),
      newest: snowflakeAt(f.now() - DAY_MS),
      complete,
    }),
  )

/** Each chat's `partial` and `current`, by chat id. */
async function flags(args: Record<string, unknown> = {}) {
  const result = await f.counts(args)
  return Object.fromEntries((result.by_chat ?? []).map(({ chat, partial, current }) => [chat.id, { partial, current }]))
}

describe("partial", () => {
  test("is true for a chat with no cursor: the mirror holds only scraps of it", async () => {
    expect(await flags()).toEqual({
      [CHANNEL]: { partial: true, current: false },
      [OTHER_CHANNEL]: { partial: true, current: false },
      [DM]: { partial: true, current: false },
    })
    expect((await f.counts()).coverage).toEqual({ partial: 3, not_current: 3 })
  })

  test("is false when an incomplete history reaches back past the window's start", async () => {
    reachingBack(CHANNEL, 45)
    expect(await flags()).toMatchObject({ [CHANNEL]: { partial: false }, [DM]: { partial: true } })
    expect((await f.counts()).coverage.partial).toBe(2)
  })

  test("is true when an incomplete history starts after the window's start", async () => {
    reachingBack(CHANNEL, 10)
    expect(await flags()).toMatchObject({ [CHANNEL]: { partial: true } })
    expect(await flags({ after: new Date(Date.parse("2020-01-01")).toISOString() })).toMatchObject({
      [CHANNEL]: { partial: true },
    })
  })

  test("depends on the window asked for", async () => {
    reachingBack(CHANNEL, 10)
    expect(await flags({ after: new Date(f.now() - 5 * DAY_MS).toISOString() })).toMatchObject({
      [CHANNEL]: { partial: false },
    })
  })

  test("is false for a complete history, however recent its oldest message", async () => {
    reachingBack(CHANNEL, 2, true)
    expect(await flags()).toMatchObject({ [CHANNEL]: { partial: false } })
  })

  test("is true for a cursor with no oldest edge, as a sync mark alone leaves", async () => {
    markSynced(f, 0, CHANNEL)
    expect(await flags()).toMatchObject({ [CHANNEL]: { partial: true, current: true } })
  })
})

describe("current", () => {
  test("is true for a chat a sync run marked in the last 15 minutes, false for a stale or unmarked one", async () => {
    markSynced(f, 0, CHANNEL)
    markSynced(f, STALE_AGO, OTHER_CHANNEL)
    expect(await flags()).toEqual({
      [CHANNEL]: { partial: true, current: true },
      [OTHER_CHANNEL]: { partial: true, current: false },
      [DM]: { partial: true, current: false },
    })
    expect((await f.counts()).coverage).toEqual({ partial: 3, not_current: 2 })
  })

  test("a fully covered, current mirror reports no gaps", async () => {
    for (const channel of [CHANNEL, OTHER_CHANNEL, DM]) reachingBack(channel, 60, true)
    markSynced(f, 60_000, CHANNEL, OTHER_CHANNEL, DM)
    expect((await f.counts()).coverage).toEqual({ partial: 0, not_current: 0 })
  })
})

describe("coverage", () => {
  test("counts every chat with counted messages, not only the rows shown, for every grouping", async () => {
    reachingBack(CHANNEL, 45)
    markSynced(f, 0, CHANNEL)
    for (const by of ["chat", "author", "day"]) {
      const result = await f.counts({ by, limit: 1 })
      expect(result.coverage).toEqual({ partial: 2, not_current: 2 })
    }
  })

  test("leaves out a chat whose messages are all outside the window or not counted", async () => {
    store(f, sentAt(DM, f.now() - 40 * DAY_MS, 3), sentAt(CHANNEL, f.now() - 2 * DAY_MS, 4, { type: 7 }))
    const result = await f.counts({ chat: CHANNEL })
    expect(result).toMatchObject({ chats: 1, coverage: { partial: 1, not_current: 1 } })
  })
})
