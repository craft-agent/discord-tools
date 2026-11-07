import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { snowflakeAt } from "../discord/snowflake"
import { parseBounds } from "./bounds"

const ID = "1400000000000000301"
const DAY = Date.parse("2026-01-02T00:00:00Z")

/** The message of the `invalid_argument` error a call fails with. */
function refusal(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (isToolError(error) && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the call to fail")
}

describe("parseBounds", () => {
  test("no bound is no bound", () => {
    expect(parseBounds()).toEqual({})
  })

  test("a snowflake id is used as it is, for both", () => {
    expect(parseBounds(ID)).toEqual({ before: ID })
    expect(parseBounds(undefined, ID)).toEqual({ after: ID })
    expect(parseBounds("1400000000000000400", ID)).toEqual({ before: "1400000000000000400", after: ID })
  })

  test("a date is UTC midnight: before excludes it, after includes messages made at it", () => {
    expect(parseBounds("2026-01-02")).toEqual({ before: snowflakeAt(DAY) })
    expect(parseBounds(undefined, "2026-01-02")).toEqual({ after: String(BigInt(snowflakeAt(DAY)) - 1n) })
  })

  test("a timestamp with a zone names its instant, whatever the offset", () => {
    const first = parseBounds("2026-01-02T09:00:00+09:00").before
    expect(first).toBe(snowflakeAt(DAY))
    expect(parseBounds("2026-01-02T00:00:00Z").before).toBe(first)
    expect(parseBounds("2026-01-01T19:00-05:00").before).toBe(first)
    expect(parseBounds("2026-01-02t00:00:00z").before).toBe(first)
    expect(parseBounds("2026-01-02T00:00:00.250Z").before).toBe(snowflakeAt(DAY + 250))
    expect(parseBounds(undefined, "2026-01-02T00:00:00.250123Z").after).toBe(
      String(BigInt(snowflakeAt(DAY + 250)) - 1n),
    )
  })

  test("a time before Discord began leaves after at the start of every channel", () => {
    expect(parseBounds(undefined, "2014-06-01")).toEqual({ after: "0" })
  })

  test.each([
    "yesterday",
    "2026-1-2",
    "2026-01-02T03:04:05",
    "2026-01-02 03:04:05Z",
    "2026-02-30",
    "2026-13-01",
    "2026-01-02T25:00:00Z",
    "01400000000000000301",
    "0",
    "",
    "12345678901234567890123",
  ])("%j is refused, naming the three forms", (value) => {
    for (const bounds of [() => parseBounds(value), () => parseBounds(undefined, value)]) {
      const message = refusal(bounds)
      expect(message).toContain("a message id")
      expect(message).toContain("a date (YYYY-MM-DD")
      expect(message).toContain("a timestamp with a zone")
    }
  })

  test("a leap day is a date only in a leap year", () => {
    expect(parseBounds("2028-02-29").before).toBe(snowflakeAt(Date.parse("2028-02-29T00:00:00Z")))
    expect(refusal(() => parseBounds("2027-02-29"))).toContain("a message id")
  })

  test("a before outside the years ids cover is refused", () => {
    expect(refusal(() => parseBounds("2014-06-01"))).toContain("outside the dates")
    expect(refusal(() => parseBounds("9999-01-01"))).toContain("outside the dates")
    expect(refusal(() => parseBounds(undefined, "9999-01-01"))).toContain("outside the dates")
  })

  test("after at or past before is refused", () => {
    expect(refusal(() => parseBounds(ID, ID))).toContain("earlier than `before`")
    expect(refusal(() => parseBounds("1400000000000000300", ID))).toContain("earlier than `before`")
    expect(refusal(() => parseBounds("2026-01-01", "2026-01-02"))).toContain("earlier than `before`")
    expect(parseBounds("2026-01-03", "2026-01-02")).toEqual({
      before: snowflakeAt(Date.parse("2026-01-03T00:00:00Z")),
      after: String(BigInt(snowflakeAt(DAY)) - 1n),
    })
  })
})
