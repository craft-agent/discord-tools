import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ToolError } from "../errors"
import { readAccount, writeAccount } from "./account-meta"
import { loginAccount } from "./client-login"
import { loginFixture } from "./client-login.testing"
import { fakeToken } from "./fake-token.testing"
import { getMeta, openMirrorForRead, openMirrorForWrite, setMeta } from "./mirror"
import { ACCOUNT_ID_META } from "./mirror-meta"
import { MIGRATIONS } from "./mirror-schema"
import { acquireSyncLock } from "./sync-lock"

let fixture: Awaited<ReturnType<typeof loginFixture>>
beforeEach(async () => {
  fixture = await loginFixture()
})
afterEach(() => fixture.harness.dispose())

test("the account record prevents replacing a label with a different identity", async () => {
  const { harness, options } = fixture
  await loginAccount(options)
  const before = await readAccount(harness.paths)
  options.readInput = async () => fakeToken("b")
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "202", username: "other" } })
  await expect(loginAccount(options)).rejects.toMatchObject({ code: "invalid_argument" })
  expect(await readAccount(harness.paths)).toEqual(before)
  expect(await readFile(harness.paths.token, "utf8")).toBe(fakeToken())
})

test("an existing mirror binding is checked even without account.json", async () => {
  const { harness, options } = fixture
  const mirror = openMirrorForWrite(harness.paths.mirror)
  setMeta(mirror, { [ACCOUNT_ID_META]: "202" })
  mirror.close()
  await expect(loginAccount(options)).rejects.toMatchObject({ code: "invalid_argument" })
  expect(await readAccount(harness.paths)).toBeUndefined()
  expect(existsSync(harness.paths.token)).toBe(false)
  const unchanged = openMirrorForRead(harness.paths.mirror)
  try {
    expect(getMeta(unchanged)[ACCOUNT_ID_META]).toBe("202")
  } finally {
    unchanged.close()
  }
})

test("a matching legacy mirror accepts login without modifying its metadata", async () => {
  const { harness, options } = fixture
  const mirror = openMirrorForWrite(harness.paths.mirror)
  setMeta(mirror, { [ACCOUNT_ID_META]: "101", sentinel: "preserved" })
  mirror.close()
  await loginAccount(options)
  const unchanged = openMirrorForRead(harness.paths.mirror)
  try {
    expect(getMeta(unchanged)).toEqual({ [ACCOUNT_ID_META]: "101", sentinel: "preserved" })
  } finally {
    unchanged.close()
  }
})

test("login signs in over an older mirror without migrating or initializing it", async () => {
  const { harness, options } = fixture
  const mirror = openMirrorForWrite(harness.paths.mirror)
  mirror.exec("PRAGMA user_version = 0")
  await loginAccount(options)
  try {
    expect(mirror.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 })
    expect(existsSync(harness.paths.token)).toBe(true)
  } finally {
    mirror.close()
  }
})

test("an older mirror's binding still refuses another account, so a rejected token can be replaced", async () => {
  const { harness, options } = fixture
  const raw = new DatabaseSync(harness.paths.mirror)
  raw.exec(MIGRATIONS[0]!)
  raw.exec(`INSERT INTO meta (key, value) VALUES ('${ACCOUNT_ID_META}', '101'); PRAGMA user_version = 1`)
  raw.close()
  await loginAccount(options)
  expect(await readAccount(harness.paths)).toMatchObject({ id: "101" })
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "202", username: "other" } })
  await expect(loginAccount(options)).rejects.toMatchObject({ code: "invalid_argument" })
  const check = new DatabaseSync(harness.paths.mirror)
  try {
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 })
  } finally {
    check.close()
  }
})

test.each(["broken JSON", "null", JSON.stringify({ id: "101", name: "example" })])(
  "malformed account state %j cannot discard the identity binding",
  async (text) => {
    const { harness, options } = fixture
    const path = join(harness.paths.dir, "account.json")
    await writeFile(path, text)
    await expect(readAccount(harness.paths)).rejects.toMatchObject({ code: "stale" })
    await expect(loginAccount(options)).rejects.toMatchObject({ code: "stale" })
    expect(await readFile(path, "utf8")).toBe(text)
    expect(harness.discord.requests).toHaveLength(0)
  },
)

test("account metadata validates both read and write shapes", async () => {
  const { harness } = fixture
  expect(await readAccount(harness.paths)).toBeUndefined()
  await expect(writeAccount(harness.paths, { id: "0", name: "example", verifiedAt: 1 })).rejects.toMatchObject({
    code: "invalid_argument",
  })
  const account = { id: "101", name: "example", verifiedAt: 1 }
  await writeAccount(harness.paths, account)
  expect(await readAccount(harness.paths)).toEqual(account)
})

test.each(["http", "transport", "input", "load"])("%s errors never expose a candidate or raw cause", async (kind) => {
  const { harness, options } = fixture
  const candidate = fakeToken().replaceAll(".", "-")
  const message = `${candidate} ${fakeToken("b")}`
  options.readInput = async () => candidate
  if (kind === "http") harness.discord.route("GET", "/users/@me", { status: 400, json: { message } })
  if (kind === "transport") {
    await harness.warm()
    harness.discord.failNext({ dispatched: true, message })
  }
  if (kind === "input")
    options.readInput = async () => {
      throw new ToolError("invalid_argument", message, { cause: new Error(message) })
    }
  if (kind === "load") {
    options.transport = undefined
    options.loadTransport = async () => {
      throw new Error(message)
    }
  }
  const error = (await loginAccount(options).catch((error: unknown) => error)) as Error
  expect(error).toBeInstanceOf(ToolError)
  expect(String(error) + String(error.cause)).not.toContain(candidate)
  expect(String(error) + String(error.cause)).not.toContain(fakeToken("b"))
  expect(error.cause).toBeUndefined()
  expect(existsSync(harness.paths.token)).toBe(false)
  const release = acquireSyncLock(harness.paths.lock)
  expect(release).toBeFunction()
  release?.()
})
