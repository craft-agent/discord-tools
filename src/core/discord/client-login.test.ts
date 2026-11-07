import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { readAccount } from "./account-meta"
import { loginAccount } from "./client-login"
import { loginFixture } from "./client-login.testing"
import { headerOf } from "./fake-discord.testing"
import { fakeToken } from "./fake-token.testing"
import { acquireSyncLock } from "./sync-lock"
import { recordRejected, rejectedAt, writeTokenFile } from "./token"

let fixture: Awaited<ReturnType<typeof loginFixture>>
beforeEach(async () => {
  fixture = await loginFixture()
})
afterEach(() => fixture.harness.dispose())

test("a set environment wins without consuming input or replacing the file", async () => {
  const { harness, options } = fixture
  await writeTokenFile(harness.paths, fakeToken("file"))
  options.env = { [options.tokenVariable]: fakeToken("b") }
  options.readInput = async () => {
    throw new Error("input must not be read")
  }
  const envBefore = { ...options.env }
  expect(await loginAccount(options)).toEqual({ id: "101", name: "example", source: "variable" })
  expect(headerOf(harness.discord.api[0]!, "authorization")).toBe(fakeToken("b"))
  expect(await readFile(harness.paths.token, "utf8")).toBe(fakeToken("file"))
  expect(options.env).toEqual(envBefore)
})

test("environment login creates no token file or mirror", async () => {
  const { harness, options } = fixture
  options.env = { [options.tokenVariable]: fakeToken() }
  await loginAccount(options)
  expect(existsSync(harness.paths.token)).toBe(false)
  expect(existsSync(harness.paths.mirror)).toBe(false)
  expect(await readAccount(harness.paths)).toEqual({ id: "101", name: "example", verifiedAt: harness.now() })
})

test.each(["", "  \n", "not one word"])("set but invalid environment %j never falls back", async (value) => {
  const { harness, options } = fixture
  await writeTokenFile(harness.paths, fakeToken("file"))
  options.env = { [options.tokenVariable]: value }
  let inputs = 0
  options.readInput = async () => {
    inputs++
    return fakeToken()
  }
  await expect(loginAccount(options)).rejects.toMatchObject({ code: "unauthenticated" })
  expect(inputs).toBe(0)
  expect(harness.discord.requests).toHaveLength(0)
  expect(await readFile(harness.paths.token, "utf8")).toBe(fakeToken("file"))
})

test("input is trimmed and saved only after validation with private permissions", async () => {
  const { harness, options } = fixture
  options.readInput = async () => ` \n${fakeToken()}\n `
  await recordRejected(harness.paths, fakeToken("b"), harness.now())
  harness.discord.route("GET", "/users/@me", () => {
    expect(existsSync(harness.paths.token)).toBe(false)
    expect(existsSync(join(harness.paths.dir, "account.json"))).toBe(false)
    expect(existsSync(harness.paths.auth)).toBe(true)
    return { status: 200, json: { id: "101", username: "example" } }
  })
  expect(await loginAccount(options)).toEqual({ id: "101", name: "example", source: "file" })
  expect(await readFile(harness.paths.token, "utf8")).toBe(fakeToken())
  for (const path of [harness.paths.token, join(harness.paths.dir, "account.json")]) {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
  expect((await stat(harness.paths.dir)).mode & 0o777).toBe(0o700)
  expect(existsSync(harness.paths.auth)).toBe(false)
  expect(harness.discord.requests.length).toBeLessThanOrEqual(4)
})

test("a rejected candidate preserves the previous token and identity", async () => {
  const { harness, options } = fixture
  await loginAccount(options)
  const before = await readAccount(harness.paths)
  options.readInput = async () => fakeToken("b")
  harness.discord.route("GET", "/users/@me", { status: 401, json: { message: fakeToken("b") } })
  await expect(loginAccount(options)).rejects.toMatchObject({ code: "unauthenticated" })
  expect(await readFile(harness.paths.token, "utf8")).toBe(fakeToken())
  expect(await readAccount(harness.paths)).toEqual(before)
  expect(await rejectedAt(harness.paths, fakeToken("b"))).toBeNumber()
  const release = acquireSyncLock(harness.paths.lock)
  expect(release).toBeFunction()
  release?.()
})

test.each([
  null,
  {},
  { id: "0", username: "example" },
  { id: "101", username: " " },
  { id: "101", username: fakeToken() },
])("malformed account response %j persists nothing", async (json) => {
  const { harness, options } = fixture
  harness.discord.route("GET", "/users/@me", { status: 200, json })
  await expect(loginAccount(options)).rejects.toMatchObject({ code: "upstream_error" })
  expect(existsSync(harness.paths.token)).toBe(false)
  expect(await readAccount(harness.paths)).toBeUndefined()
})

test("a held sync lock refuses login without consuming input, and login releases its lock", async () => {
  const { harness, options } = fixture
  const release = acquireSyncLock(harness.paths.lock)!
  let inputs = 0
  const readInput = options.readInput
  options.readInput = async () => {
    inputs++
    return readInput()
  }
  try {
    await expect(loginAccount(options)).rejects.toMatchObject({ code: "stale" })
    expect(inputs).toBe(0)
    expect(harness.discord.requests).toHaveLength(0)
  } finally {
    release()
  }
  await loginAccount(options)
  const again = acquireSyncLock(harness.paths.lock)
  expect(again).toBeFunction()
  again?.()
})

test("a new environment token clears rejection only after verification", async () => {
  const { harness, options } = fixture
  await recordRejected(harness.paths, fakeToken("b"), harness.now())
  options.env = { [options.tokenVariable]: fakeToken() }
  harness.discord.route("GET", "/users/@me", () => {
    expect(existsSync(harness.paths.auth)).toBe(true)
    return { status: 200, json: { id: "101", username: "example" } }
  })
  await loginAccount(options)
  expect(existsSync(harness.paths.auth)).toBe(false)
})
