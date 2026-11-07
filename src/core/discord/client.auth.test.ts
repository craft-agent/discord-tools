import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { FAKE_TOKEN, type Harness, TOKEN_VARIABLE, createHarness } from "./client.testing"
import { fakeToken } from "./fake-token.testing"
import { writeTokenFile } from "./token"

const OTHER_TOKEN = fakeToken("b")

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
  harness.discord.route("POST", "/channels/2/messages", { status: 200, json: { id: "9" } })
})

afterEach(() => harness.dispose())

const unauthorized = { status: 401, json: { code: 0, message: "401: Unauthorized" } }

describe("a missing token", () => {
  test("throws unauthenticated naming the variable, and sends nothing", async () => {
    const client = harness.another({ env: {} })
    await expect(client.read("GET", "/users/@me")).rejects.toMatchObject({
      code: "unauthenticated",
      message: expect.stringContaining(TOKEN_VARIABLE),
    })
    await expect(client.write("POST", "/channels/2/messages")).rejects.toMatchObject({ code: "unauthenticated" })
    expect(harness.discord.requests).toHaveLength(0)
  })

  test("is read from the token file when the variable is unset", async () => {
    await writeTokenFile(harness.paths, FAKE_TOKEN)
    await harness.another({ env: {} }).read("GET", "/users/@me")
    expect(harness.discord.api[0]!.headers.find(([name]) => name === "authorization")![1]).toBe(FAKE_TOKEN)
  })
})

describe("a build number that cannot be read", () => {
  test("stops the request before any API request is sent", async () => {
    harness.discord.buildNumber = undefined
    await expect(harness.client.read("GET", "/users/@me")).rejects.toMatchObject({ code: "upstream_error" })
    await expect(harness.client.write("POST", "/channels/2/messages")).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("no request was sent"),
    })
    expect(harness.discord.api).toHaveLength(0)
  })

  test("is tried again by the next call", async () => {
    harness.discord.buildNumber = undefined
    await expect(harness.client.read("GET", "/users/@me")).rejects.toThrow()
    harness.discord.buildNumber = 5
    expect(await harness.client.read("GET", "/users/@me")).toEqual({ id: "1" })
  })
})

describe("a rejected token", () => {
  test("throws unauthenticated and records the rejection", async () => {
    harness.discord.route("GET", "/users/@me", unauthorized)
    await expect(harness.client.read("GET", "/users/@me")).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Discord rejected the token (401); give this account a new token.",
    })
    expect(existsSync(harness.paths.auth)).toBe(true)
    expect(readFileSync(harness.paths.auth, "utf8")).not.toContain(FAKE_TOKEN)
  })

  test("is refused by the next call and the next client without sending anything", async () => {
    harness.discord.route("POST", "/channels/2/messages", unauthorized)
    await expect(harness.client.write("POST", "/channels/2/messages")).rejects.toMatchObject({
      code: "unauthenticated",
    })
    const sent = harness.discord.requests.length

    const expected = {
      code: "unauthenticated",
      message: `Discord rejected this account's token at ${new Date(harness.now()).toISOString()}; give it a new token.`,
    }
    await expect(harness.client.read("GET", "/users/@me")).rejects.toMatchObject(expected)
    await expect(harness.another().read("GET", "/users/@me")).rejects.toMatchObject(expected)
    expect(harness.discord.requests).toHaveLength(sent)
  })

  test("does not stop a different token", async () => {
    harness.discord.route("GET", "/users/@me", unauthorized)
    await expect(harness.client.read("GET", "/users/@me")).rejects.toThrow()
    harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
    const fresh = harness.another({ env: { [TOKEN_VARIABLE]: OTHER_TOKEN } })
    expect(await fresh.read("GET", "/users/@me")).toEqual({ id: "1" })
  })

  test("is forgotten when a new token is stored", async () => {
    harness.discord.route("GET", "/users/@me", unauthorized)
    await expect(harness.client.read("GET", "/users/@me")).rejects.toThrow()
    harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })

    await writeTokenFile(harness.paths, FAKE_TOKEN)
    expect(existsSync(harness.paths.auth)).toBe(false)
    expect(await harness.another({ env: {} }).read("GET", "/users/@me")).toEqual({ id: "1" })
  })
})

describe("a two-factor challenge", () => {
  test("throws forbidden and leaves the token alone", async () => {
    harness.discord.route("POST", "/channels/2/messages", [
      { status: 401, json: { code: 60003, message: "Two factor is required for this operation" } },
      { status: 200, json: { id: "9" } },
    ])
    await expect(harness.client.write("POST", "/channels/2/messages")).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("two-factor"),
    })
    expect(existsSync(harness.paths.auth)).toBe(false)
    expect(await harness.client.write("POST", "/channels/2/messages")).toEqual({ id: "9" })
  })
})

describe("masking", () => {
  test("hides the token Discord echoes back, shaped like a token or not", async () => {
    const plain = "plain-user-token-without-dots"
    for (const [token, echoed] of [
      [FAKE_TOKEN, `Invalid Form Body ${FAKE_TOKEN}`],
      [plain, `Invalid Form Body ${plain}`],
    ] as const) {
      harness.discord.route("POST", "/channels/2/messages", { status: 400, json: { code: 50035, message: echoed } })
      const client = harness.another({ env: { [TOKEN_VARIABLE]: token } })
      const error = (await client.write("POST", "/channels/2/messages").catch((e: unknown) => e)) as Error
      expect(error.message).toContain("<token>")
      expect(error.message).not.toContain(token)
    }
  })

  test("hides a token in the text of a failed connection, and in its cause", async () => {
    await harness.warm()
    harness.discord.failNext({ dispatched: true, message: `reset while sending ${FAKE_TOKEN}` })
    const written = (await harness.client.write("POST", "/channels/2/messages").catch((e: unknown) => e)) as Error
    harness.discord.failNext({ dispatched: false, message: `refused for ${FAKE_TOKEN}` })
    const unsent = (await harness.client.write("POST", "/channels/2/messages").catch((e: unknown) => e)) as Error
    harness.discord.failNext({ dispatched: true, message: `reset while reading ${FAKE_TOKEN}` })
    const read = (await harness.client.read("GET", "/users/@me").catch((e: unknown) => e)) as Error

    for (const error of [written, unsent, read]) {
      expect(String(error.message) + String(error.cause)).not.toContain(FAKE_TOKEN)
    }
    expect(String((written as Error).cause)).toContain("<token>")
    expect(unsent.message).toContain("<token>")
    expect(read.message).toContain("<token>")
  })
})
