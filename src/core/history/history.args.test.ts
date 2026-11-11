import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ToolError } from "../errors"
import { CHANNEL, SERVER } from "../discord/objects.testing"
import { snowflakeAt } from "../discord/snowflake"
import { checkArgs, COUNTS_LIMIT_DEFAULT, COUNTS_WINDOW_MS, DAYS_LIMIT_DEFAULT, windowOf } from "./args"
import { createHistoryFixture, DAY_MS, type HistoryFixture } from "./history.testing"
import { HISTORY_METHODS, historyReadInput } from "./schemas"

/** The message `checkArgs` refuses the arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(historyReadInput.parse({ method: "counts", ...args }))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

const accepted = (args: Record<string, unknown>) =>
  expect(() => checkArgs(historyReadInput.parse({ method: "counts", ...args }))).not.toThrow()

describe("the arguments", () => {
  test("counts takes its own", () => {
    accepted({})
    accepted({ account: "default" })
    accepted({
      by: "day",
      after: "2026-01-01",
      before: "2026-02-01T00:00:00+09:00",
      server: SERVER,
      chat: CHANNEL,
      time_zone: "Asia/Tokyo",
      limit: 100,
    })
    accepted({ by: "author", after: "1400000000000000050", before: "1400000000000000060", limit: 1 })
  })

  test("an unknown argument is refused by the schema", () => {
    expect(() => historyReadInput.strict().parse({ method: "counts", color: "red" })).toThrow()
  })

  test("an argument the method does not take is refused, naming what it takes", () => {
    const args = historyReadInput.parse({ method: "counts" })
    expect(() => checkArgs({ ...args, since: "2026-01-01" } as never)).toThrow("it takes: account, method, by, after")
  })

  test.each(["server", "chat"])("%s must be an id, not a name", (field) => {
    expect(refusal({ [field]: "general" })).toContain(`\`${field}\` must be an id`)
    expect(refusal({ [field]: "0" })).toContain(`\`${field}\` must be an id`)
  })

  test("after and before are a message id, a date or a timestamp with a zone, and nothing else", () => {
    for (const field of ["after", "before"]) {
      for (const value of ["yesterday", "2026-02-30", "2026-01-01T00:00:00", "12:00", "-5"]) {
        expect(refusal({ [field]: value })).toContain(`\`${field}\` must be a message id`)
      }
      expect(refusal({ [field]: "x".repeat(100) })).not.toContain("x".repeat(41))
    }
  })

  test("after must be earlier than before", () => {
    expect(refusal({ after: "2026-02-01", before: "2026-01-01" })).toContain("`after` must be earlier than `before`")
    expect(refusal({ after: "1400000000000000050", before: "1400000000000000050" })).toContain(
      "`after` must be earlier than `before`",
    )
  })

  test("time_zone is an IANA zone name", () => {
    for (const time_zone of ["Mars/Olympus", "Tokyo", "", "UTC+9"]) {
      expect(refusal({ time_zone })).toContain("`time_zone` must be an IANA time zone name")
    }
    for (const time_zone of ["UTC", "Asia/Tokyo", "Asia/Kathmandu", "America/New_York"]) accepted({ time_zone })
  })

  test("limit has defaults and is at most 100", () => {
    expect(COUNTS_LIMIT_DEFAULT).toBe(20)
    expect(DAYS_LIMIT_DEFAULT).toBe(30)
    expect(refusal({ limit: 101 })).toContain("limit is at most 100 for method counts")
    accepted({ limit: 100 })
    for (const args of [{ limit: 0 }, { limit: 1.5 }]) {
      expect(() => historyReadInput.parse({ method: "counts", ...args })).toThrow()
    }
  })

  test("the methods are the ones the tool dispatches", () => {
    expect([...HISTORY_METHODS]).toEqual(["counts"])
    expect(() => historyReadInput.parse({ method: "totals" })).toThrow()
  })
})

describe("the window", () => {
  const now = 1_700_000_000_000

  test("starts 30 days before now and has no end when nothing is given", () => {
    expect(COUNTS_WINDOW_MS).toBe(30 * DAY_MS)
    expect(windowOf(historyReadInput.parse({ method: "counts" }), now)).toEqual({
      after: snowflakeAt(now - 30 * DAY_MS),
    })
  })

  test("takes the bounds given", () => {
    const args = historyReadInput.parse({ method: "counts", after: "1400000000000000050", before: "2026-01-01" })
    expect(windowOf(args, now)).toEqual({ after: "1400000000000000050", before: snowflakeAt(Date.parse("2026-01-01")) })
  })

  test("a before older than the default start needs an after", () => {
    const old = historyReadInput.parse({ method: "counts", before: "2020-01-01" })
    expect(() => windowOf(old, now)).toThrow("give `after` too")
    const recent = historyReadInput.parse({ method: "counts", before: new Date(now - DAY_MS).toISOString() })
    expect(windowOf(recent, now).after).toBe(snowflakeAt(now - 30 * DAY_MS))
  })
})

describe("a call", () => {
  let f: HistoryFixture
  beforeEach(async () => {
    f = await createHistoryFixture()
  })
  afterEach(async () => {
    await f.dispose()
  })

  test("with a refused argument fails as invalid_argument before anything is opened or requested", async () => {
    expect((await failure(f.counts({ limit: 101 }))).code).toBe("invalid_argument")
    expect((await failure(f.counts({ time_zone: "Mars/Olympus" }))).code).toBe("invalid_argument")
    expect((await failure(f.counts({ before: "2020-01-01" }))).code).toBe("invalid_argument")
    expect(f.discord.requests).toEqual([])
  })

  test("with an unknown method or argument is refused by the schema", async () => {
    await expect(f.history({ method: "totals" })).rejects.toThrow()
    await expect(f.history({ method: "counts", color: "red" })).rejects.toThrow()
  })
})
