import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, DM } from "../discord/objects.testing"
import { seedWorld, store } from "../search/search.testing"
import { localDays, QUARTER_HOUR_MS } from "./days"
import { createHistoryFixture, DAY_MS, type HistoryFixture, sentAt, sentByMe } from "./history.testing"

let f: HistoryFixture
beforeEach(async () => {
  f = await createHistoryFixture()
  seedWorld(f)
})
afterEach(async () => {
  await f.dispose()
})

/** Counts per day of a `by` `day` call over March 2026, in `time_zone`. */
const days = async (time_zone: string, extra: Record<string, unknown> = {}) =>
  (await f.counts({ by: "day", after: "2026-02-28", time_zone, ...extra })).by_day

describe("by day", () => {
  beforeEach(() => {
    store(
      f,
      sentAt(CHANNEL, "2026-03-01T23:30:00Z"),
      sentByMe(CHANNEL, "2026-03-01T10:00:00Z"),
      sentAt(DM, "2026-03-02T14:30:00Z"),
    )
  })

  test("cuts days at midnight UTC", async () => {
    expect(await days("UTC")).toEqual([
      { day: "2026-03-01", messages: 2, from_me: 1 },
      { day: "2026-03-02", messages: 1, from_me: 0 },
    ])
  })

  test("cuts the same messages differently in Asia/Tokyo", async () => {
    expect(await days("Asia/Tokyo")).toEqual([
      { day: "2026-03-01", messages: 1, from_me: 1 },
      { day: "2026-03-02", messages: 2, from_me: 0 },
    ])
  })

  test("cuts them west of UTC too", async () => {
    expect(await days("America/New_York")).toEqual([
      { day: "2026-03-01", messages: 2, from_me: 1 },
      { day: "2026-03-02", messages: 1, from_me: 0 },
    ])
  })

  test("cuts at a +05:45 midnight, to the quarter hour", async () => {
    store(f, sentAt(CHANNEL, "2026-03-01T18:14:59.999Z", 1), sentAt(CHANNEL, "2026-03-01T18:15:00Z", 2))
    expect(await days("Asia/Kathmandu")).toEqual([
      { day: "2026-03-01", messages: 2, from_me: 1 },
      { day: "2026-03-02", messages: 3, from_me: 0 },
    ])
  })

  test("names the zone it used, canonically, for every grouping", async () => {
    expect((await f.counts({ by: "day", time_zone: "asia/tokyo" })).time_zone).toBe("Asia/Tokyo")
    expect((await f.counts({ by: "chat", time_zone: "Asia/Tokyo" })).time_zone).toBe("Asia/Tokyo")
    expect((await f.counts({ by: "author", time_zone: "UTC" })).time_zone).toBe("UTC")
  })

  test("uses the machine's zone by default", async () => {
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const result = await f.counts({ by: "day", after: "2026-02-28" })
    expect(result.time_zone).toBe(machine)
    expect(result.by_day).toEqual(await days(machine))
    expect((await f.counts()).time_zone).toBe(machine)
  })

  test("refuses an unknown zone", async () => {
    expect((await failure(f.counts({ by: "day", time_zone: "Mars/Olympus" }))).code).toBe("invalid_argument")
  })

  test("lists the newest days that have messages, the oldest first, and leaves empty days out", async () => {
    store(
      f,
      sentAt(CHANNEL, "2026-03-05T12:00:00Z", 1),
      sentAt(CHANNEL, "2026-03-09T12:00:00Z", 2),
      sentByMe(CHANNEL, "2026-03-09T13:00:00Z", 3),
      sentAt(CHANNEL, "2026-03-12T12:00:00Z", 4),
    )
    const result = await f.counts({ by: "day", after: "2026-02-28", time_zone: "UTC", limit: 3 })
    expect(result.by_day).toEqual([
      { day: "2026-03-05", messages: 1, from_me: 0 },
      { day: "2026-03-09", messages: 2, from_me: 1 },
      { day: "2026-03-12", messages: 1, from_me: 0 },
    ])
    expect(result).toMatchObject({ more: true, total: 7, from_me: 2, chats: 2 })
    expect((await f.counts({ by: "day", after: "2026-02-28", time_zone: "UTC", limit: 5 })).more).toBe(false)
  })

  test("shows 30 days by default, and still totals the whole window", async () => {
    const start = Date.parse("2026-04-01T12:00:00Z")
    store(f, ...Array.from({ length: 35 }, (_, i) => sentAt(CHANNEL, start + i * DAY_MS, 10 + i)))
    const result = await f.counts({ by: "day", after: "2026-03-10", time_zone: "UTC" })
    expect(result.by_day).toHaveLength(30)
    expect(result.by_day?.[0]?.day).toBe("2026-04-06")
    expect(result.by_day?.at(-1)?.day).toBe("2026-05-05")
    expect(result).toMatchObject({ more: true, total: 35 })
  })
})

describe("localDays", () => {
  const bucketAt = (iso: string) => Date.parse(iso) / QUARTER_HOUR_MS

  test("sums the buckets of a day and orders the days", () => {
    const buckets = [
      { bucket: bucketAt("2026-03-03T01:00:00Z"), messages: 1, from_me: 0 },
      { bucket: bucketAt("2026-03-01T23:45:00Z"), messages: 2, from_me: 1 },
      { bucket: bucketAt("2026-03-01T00:00:00Z"), messages: 3, from_me: 2 },
    ]
    expect(localDays(buckets, "UTC")).toEqual([
      { day: "2026-03-01", messages: 5, from_me: 3 },
      { day: "2026-03-03", messages: 1, from_me: 0 },
    ])
    expect(localDays([], "UTC")).toEqual([])
  })

  test("follows a zone's daylight saving change", () => {
    const buckets = [
      { bucket: bucketAt("2026-03-08T06:45:00Z"), messages: 1, from_me: 0 },
      { bucket: bucketAt("2026-03-08T07:00:00Z"), messages: 1, from_me: 0 },
    ]
    expect(localDays(buckets, "America/New_York").map(({ day }) => day)).toEqual(["2026-03-08"])
    expect(localDays(buckets, "Asia/Tokyo").map(({ day }) => day)).toEqual(["2026-03-08"])
  })
})
