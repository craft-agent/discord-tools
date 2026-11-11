import { describe, expect, test } from "bun:test"
import { localTimeIn } from "./local-time"

const at = (iso: string) => Date.parse(iso)

describe("localTimeIn", () => {
  test("UTC is written with +00:00, never Z", () => {
    expect(localTimeIn("UTC")(at("2026-03-02T08:30:00Z"))).toBe("2026-03-02T08:30:00+00:00")
  })

  test.each([
    ["Asia/Tokyo", "2026-03-02T17:30:00+09:00"],
    ["Asia/Kathmandu", "2026-03-02T14:15:00+05:45"],
    ["America/St_Johns", "2026-03-02T05:00:00-03:30"],
    ["America/New_York", "2026-03-02T03:30:00-05:00"],
  ])("%s", (zone, expected) => {
    expect(localTimeIn(zone)(at("2026-03-02T08:30:00Z"))).toBe(expected)
  })

  test("the offset follows daylight saving time: spring forward", () => {
    const local = localTimeIn("America/New_York")
    expect(local(at("2026-03-08T06:59:59Z"))).toBe("2026-03-08T01:59:59-05:00")
    expect(local(at("2026-03-08T07:00:00Z"))).toBe("2026-03-08T03:00:00-04:00")
  })

  test("the offset follows daylight saving time: fall back repeats an hour with each offset", () => {
    const local = localTimeIn("America/New_York")
    expect(local(at("2026-11-01T05:59:59Z"))).toBe("2026-11-01T01:59:59-04:00")
    expect(local(at("2026-11-01T06:00:00Z"))).toBe("2026-11-01T01:00:00-05:00")
  })

  test("a zone that changes its offset by half an hour", () => {
    const local = localTimeIn("Australia/Lord_Howe")
    expect(local(at("2026-01-01T00:00:00Z"))).toBe("2026-01-01T11:00:00+11:00")
    expect(local(at("2026-07-01T00:00:00Z"))).toBe("2026-07-01T10:30:00+10:30")
  })

  test("midnight is hour 00, and a day ends at the local midnight", () => {
    const local = localTimeIn("Asia/Tokyo")
    expect(local(at("2026-03-01T15:00:00Z"))).toBe("2026-03-02T00:00:00+09:00")
    expect(local(at("2026-03-01T14:59:59Z"))).toBe("2026-03-01T23:59:59+09:00")
  })

  test("milliseconds are cut, not rounded", () => {
    expect(localTimeIn("UTC")(at("2026-03-02T08:30:00Z") + 999)).toBe("2026-03-02T08:30:00+00:00")
  })
})
