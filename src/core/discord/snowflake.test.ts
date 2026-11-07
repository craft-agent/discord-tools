import { describe, expect, test } from "bun:test"
import { isSnowflake, snowflakeAt, snowflakeTime } from "./snowflake"

/** A made-up id above 2^53 (9007199254740992), made at 2026-01-01T00:00:00Z. */
const BIG_ID = "1455024000000000000"

describe("isSnowflake", () => {
  test("accepts decimal strings of up to 19 digits that fit a signed 64-bit INTEGER", () => {
    for (const id of ["1", "123456789012", BIG_ID, "9223372036854775807"]) expect(isSnowflake(id)).toBe(true)
  })

  test("refuses anything else", () => {
    const refused = [
      "",
      "0",
      "012",
      "-1",
      "1.5",
      "1e5",
      " 1",
      "1 ",
      "a",
      "9223372036854775808",
      "18446744073709551615",
      "123456789012345678901",
    ]
    for (const id of refused) expect(isSnowflake(id)).toBe(false)
    for (const value of [1, 1n, null, undefined, {}, ["1"]]) expect(isSnowflake(value)).toBe(false)
  })
})

describe("snowflakeTime and snowflakeAt", () => {
  test("read the time out of an id above 2^53 without losing it", () => {
    expect(snowflakeTime("175928847299117063")).toBe(1_462_015_105_796)
    expect(snowflakeTime(BIG_ID)).toBe(Number((BigInt(BIG_ID) >> 22n) + 1_420_070_400_000n))
  })

  test("snowflakeAt gives the smallest id at a time", () => {
    const ms = 1_462_015_105_796
    const id = snowflakeAt(ms)
    expect(isSnowflake(id)).toBe(true)
    expect(snowflakeTime(id)).toBe(ms)
    expect(BigInt(id) % 4_194_304n).toBe(0n)
    expect(snowflakeTime(String(BigInt(id) - 1n))).toBe(ms - 1)
  })

  test("snowflakeAt of a recent time exceeds 2^53 and stays exact", () => {
    const ms = 1_800_000_000_000
    const id = snowflakeAt(ms)
    expect(BigInt(id)).toBeGreaterThan(2n ** 53n)
    expect(snowflakeTime(id)).toBe(ms)
  })

  test("snowflakeAt of a time before Discord's epoch is 0", () => {
    expect(snowflakeAt(0)).toBe("0")
    expect(snowflakeAt(1_420_070_400_000)).toBe("0")
  })
})
