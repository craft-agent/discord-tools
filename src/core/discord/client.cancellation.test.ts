import { afterEach, beforeEach, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { BUILD_CACHE_FILE, BUILD_TTL_MS } from "./build-number"
import { type Harness, createHarness } from "./client.testing"
import { TransportFailure } from "./transport"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
})

afterEach(() => harness.dispose())

test("a preaborted cold read or write sends neither navigation nor API requests", async () => {
  const signal = AbortSignal.abort()
  for (const kind of ["read", "write"] as const) {
    await expect(harness.client[kind]("GET", "/users/@me", { signal })).rejects.toMatchObject({ name: "AbortError" })
  }
  expect(harness.discord.requests).toHaveLength(0)
  expect(harness.client.requests).toBe(0)
})

test("cancellation during navigation pacing sends nothing and allows a later call", async () => {
  await harness.warm()
  await harness.client.read("GET", "/users/@me")
  await rm(join(harness.stateDir, BUILD_CACHE_FILE))
  const controller = new AbortController()
  const client = harness.another({
    sleep: async (ms) => {
      harness.advance(ms)
      controller.abort()
    },
  })
  await expect(client.read("GET", "/users/@me", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(harness.discord.requests).toHaveLength(1)
  expect(client.requests).toBe(0)
  expect(await client.read("GET", "/users/@me")).toEqual({ id: "1" })
  expect(harness.discord.login).toHaveLength(1)
})

test("cancellation during authenticated pacing prevents a write", async () => {
  await harness.warm()
  await harness.client.read("GET", "/users/@me")
  const controller = new AbortController()
  const client = harness.another({
    sleep: async (ms) => {
      harness.advance(ms)
      controller.abort()
    },
  })
  await expect(client.write("POST", "/channels/2/messages", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(harness.discord.requests).toHaveLength(1)
})

test("an aborted navigation never falls back to a stale cached build", async () => {
  await harness.warm()
  harness.advance(BUILD_TTL_MS)
  const controller = new AbortController()
  let sends = 0
  const client = harness.another({
    transport: async (request) => {
      sends += 1
      expect(request.navigation).toBe(true)
      expect(request.signal).toBe(controller.signal)
      controller.abort()
      throw new TransportFailure("cancelled", true)
    },
  })
  await expect(client.read("GET", "/users/@me", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(sends).toBe(1)
})

test("a concurrent caller retries preparation cancelled by its first caller", async () => {
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let firstNavigation = true
  const client = harness.another({
    transport: async (request) => {
      if (request.navigation && firstNavigation) {
        firstNavigation = false
        entered.resolve()
        await release.promise
        throw new TransportFailure("cancelled", true)
      }
      return harness.discord.transport(request)
    },
  })
  const first = client.read("GET", "/users/@me", { signal: controller.signal }).catch((error: unknown) => error)
  await entered.promise
  const second = client.read("GET", "/users/@me")
  controller.abort()
  release.resolve()
  expect(await first).toMatchObject({ name: "AbortError" })
  expect(await second).toEqual({ id: "1" })
  expect(harness.discord.api).toHaveLength(1)
})

test("cancellation while the lazy transport loads never dispatches its request", async () => {
  const controller = new AbortController()
  const client = harness.another({
    transport: undefined,
    loadTransport: async () => {
      controller.abort()
      return harness.discord.transport
    },
  })
  await expect(client.read("GET", "/users/@me", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
  expect(harness.discord.requests).toHaveLength(0)
})
