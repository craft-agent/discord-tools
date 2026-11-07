import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BudgetSpent } from "./client"
import { PACE_MAX_MS, PACE_MIN_MS } from "./pacing"
import { type Harness, createHarness } from "./client.testing"
import { isToolError } from "../errors"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
})

afterEach(() => harness.dispose())

describe("pacing", () => {
  test("spaces the build number page and every request, the first of all excepted", async () => {
    await harness.client.read("GET", "/users/@me")
    await harness.client.read("GET", "/users/@me")
    expect(harness.discord.requests.map((request) => request.path)).toEqual(["/login", "/users/@me", "/users/@me"])
    expect(harness.sleeps).toEqual([1100, 1100])
    expect(harness.sentAt.map((at, i) => at - (harness.sentAt[i - 1] ?? at))).toEqual([0, 1100, 1100])
  })

  test("counts the time that has passed since the last request", async () => {
    await harness.client.read("GET", "/users/@me")
    harness.sleeps.length = 0
    harness.advance(400)
    await harness.client.read("GET", "/users/@me")
    harness.advance(5000)
    await harness.client.read("GET", "/users/@me")
    expect(harness.sleeps).toEqual([700])
  })

  test("waits between 0.6 and 1.6 seconds", async () => {
    const waits: number[] = []
    for (const random of [0, 0.999999, 0.5]) {
      const client = harness.another({ random: () => random })
      await client.read("GET", "/users/@me")
      waits.push(harness.sleeps.at(-1)!)
    }
    expect(waits[0]).toBe(PACE_MIN_MS)
    expect(waits[1]).toBeGreaterThan(PACE_MAX_MS - 1)
    expect(waits[1]).toBeLessThan(PACE_MAX_MS)
    expect(waits[2]).toBe(1100)
  })

  test("is shared by every client in the process", async () => {
    await harness.client.read("GET", "/users/@me")
    harness.sleeps.length = 0
    const other = harness.another()
    await other.read("GET", "/users/@me")
    expect(harness.sleeps).toEqual([1100])
  })

  test("serves concurrent calls one after another", async () => {
    await harness.client.read("GET", "/users/@me")
    harness.sentAt.length = 0
    await Promise.all([
      harness.client.read("GET", "/users/@me"),
      harness.client.read("GET", "/users/@me"),
      harness.client.read("GET", "/users/@me"),
    ])
    expect(harness.sentAt.map((at, i) => at - (harness.sentAt[i - 1] ?? at))).toEqual([0, 1100, 1100])
  })

  test("reads the build number once for a label", async () => {
    await harness.client.read("GET", "/users/@me")
    await harness.another().read("GET", "/users/@me")
    expect(harness.discord.login).toHaveLength(1)
  })
})

describe("the budget", () => {
  test("lets the requests through, the build number page included, and then refuses before sending", async () => {
    const client = harness.another({ budget: 3 })
    await client.read("GET", "/users/@me")
    await client.read("GET", "/users/@me")
    expect(client.requests).toBe(3)

    const error = await client.read("GET", "/users/@me").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BudgetSpent)
    expect(isToolError(error)).toBe(false)
    expect(harness.discord.requests).toHaveLength(3)
    expect(client.requests).toBe(3)
  })

  test("counts a cached build number as no request", async () => {
    await harness.client.read("GET", "/users/@me")
    const client = harness.another({ budget: 1 })
    await client.read("GET", "/users/@me")
    await expect(client.write("POST", "/channels/2/messages")).rejects.toBeInstanceOf(BudgetSpent)
    expect(harness.discord.requests).toHaveLength(3)
    expect(harness.discord.login).toHaveLength(1)
  })

  test("refuses a write too", async () => {
    const client = harness.another({ budget: 0 })
    await expect(client.write("POST", "/channels/2/messages")).rejects.toBeInstanceOf(BudgetSpent)
    expect(harness.discord.requests).toHaveLength(0)
  })

  test("counts a retry of a read", async () => {
    harness.discord.route("GET", "/users/@me", [
      { status: 429, json: { retry_after: 1 } },
      { status: 200, json: { id: "1" } },
    ])
    const client = harness.another({ budget: 3 })
    await client.read("GET", "/users/@me")
    expect(client.requests).toBe(3)
  })
})
