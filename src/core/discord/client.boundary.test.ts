import { afterEach, beforeEach, expect, test } from "bun:test"
import { copyFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { BUILD_CACHE_FILE } from "./build-number"
import { FAKE_TOKEN, type Harness, TOKEN_VARIABLE, createHarness } from "./client.testing"
import { clearRejected, recordRejected, rejectedAt, writeTokenFile } from "./token"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
  await harness.warm()
})

afterEach(() => harness.dispose())

test("a prepared client refuses a token another client subsequently rejected", async () => {
  const prepared = harness.another()
  await prepared.read("GET", "/users/@me")
  harness.discord.route("GET", "/users/@me", { status: 401, json: {} })
  await expect(harness.client.read("GET", "/users/@me")).rejects.toMatchObject({ code: "unauthenticated" })
  const sent = harness.discord.requests.length
  for (const kind of ["read", "write"] as const) {
    await expect(prepared[kind]("GET", "/users/@me")).rejects.toMatchObject({ code: "unauthenticated" })
  }
  expect(harness.discord.requests).toHaveLength(sent)
})

test("rejection observed during pacing prevents an authenticated dispatch", async () => {
  await harness.client.read("GET", "/users/@me")
  const otherPaths = { ...harness.paths, auth: `${harness.paths.auth}.other` }
  await recordRejected(otherPaths, FAKE_TOKEN, harness.now())
  const client = harness.another({
    sleep: async (ms) => {
      harness.advance(ms)
      await copyFile(otherPaths.auth, harness.paths.auth)
    },
  })
  await expect(client.write("POST", "/channels/2/messages")).rejects.toMatchObject({ code: "unauthenticated" })
  expect(harness.discord.requests).toHaveLength(1)
  expect(client.requests).toBe(0)
})

test("failed rejection persistence keeps the original error and blocks this token process-wide", async () => {
  await mkdir(harness.paths.auth)
  harness.discord.route("GET", "/users/@me", { status: 401, json: {} })
  await expect(harness.client.read("GET", "/users/@me")).rejects.toMatchObject({
    code: "unauthenticated",
    message: "Discord rejected the token (401); give this account a new token.",
  })
  for (const client of [harness.client, harness.another()]) {
    await expect(client.read("GET", "/users/@me")).rejects.toMatchObject({ code: "unauthenticated" })
  }
  expect(harness.discord.requests).toHaveLength(1)
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
  expect(
    await harness.another({ env: { [TOKEN_VARIABLE]: "different-made-up-token" } }).read("GET", "/users/@me"),
  ).toEqual({ id: "1" })
})

test("saving the same token or clearing disk state cannot revive a locally rejected token", async () => {
  await recordRejected(harness.paths, FAKE_TOKEN, harness.now())
  await writeTokenFile(harness.paths, FAKE_TOKEN)
  expect(await rejectedAt(harness.paths, FAKE_TOKEN)).toBe(harness.now())
  await clearRejected(harness.paths)
  await expect(harness.another({ env: {} }).read("GET", "/users/@me")).rejects.toMatchObject({
    code: "unauthenticated",
  })
  expect(harness.discord.requests).toHaveLength(0)
})

test("internal transport errors mask an accepted short token and discard raw causes", async () => {
  const token = "plain-token"
  const client = harness.another({
    env: { [TOKEN_VARIABLE]: token },
    transport: async () => {
      throw new ToolError("internal_error", `bad ${token}`, { cause: new Error(`nested ${token}`) })
    },
  })
  for (const kind of ["read", "write"] as const) {
    const error = (await client[kind]("GET", "/users/@me").catch((error: unknown) => error)) as Error
    expect(error).toMatchObject({ code: "internal_error", message: "bad <token>" })
    expect(`${error.stack} ${String(error.cause)}`).not.toContain(token)
  }
})

test("cold preparation loader errors mask accepted short tokens", async () => {
  const token = "plain-token"
  await rm(join(harness.stateDir, BUILD_CACHE_FILE))
  const client = harness.another({
    env: { [TOKEN_VARIABLE]: token },
    transport: undefined,
    loadTransport: async () => {
      throw new Error(`loader echoed ${token}`, { cause: new Error(token) })
    },
  })
  const error = (await client.read("GET", "/users/@me").catch((error: unknown) => error)) as Error
  expect(error).toMatchObject({ code: "internal_error" })
  expect(error.message).toContain("<token>")
  expect(`${error.stack} ${String(error.cause)}`).not.toContain(token)
  expect(harness.discord.requests).toHaveLength(0)
})
