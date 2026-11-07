import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILD_STALE_OK_MS, BUILD_TTL_MS, buildNumber } from "./build-number"
import { FakeDiscord } from "./fake-discord.testing"
import { acceptLanguage, discordLocale, locale } from "./identity"

const NOW = 1_700_000_000_000

let stateDir: string
let discord: FakeDiscord
let paces: number

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), "dsc-")), "state")
  discord = new FakeDiscord()
  paces = 0
})

afterEach(() => {
  rmSync(join(stateDir, ".."), { recursive: true, force: true })
})

function lookup(now = NOW): Promise<number> {
  return buildNumber({
    stateDir,
    transport: discord.transport,
    now: () => now,
    pace: async () => {
      paces += 1
    },
  })
}

function saveCache(number: number, fetchedAt: number): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "build.json"), JSON.stringify({ number, fetchedAt }))
}

function saved(): unknown {
  return JSON.parse(readFileSync(join(stateDir, "build.json"), "utf8"))
}

describe("buildNumber", () => {
  test("reads the login page and caches the number with mode 600", async () => {
    discord.buildNumber = 123456
    expect(await lookup()).toBe(123456)
    expect(saved()).toEqual({ number: 123456, fetchedAt: NOW })
    expect(statSync(join(stateDir, "build.json")).mode & 0o777).toBe(0o600)
    expect(paces).toBe(1)
  })

  test("asks like a navigation, without credentials", async () => {
    await lookup()
    const [request] = discord.requests
    expect(request!.method).toBe("GET")
    expect(request!.url).toBe("https://discord.com/login")
    expect(request!.navigation).toBe(true)
    expect(request!.headers).toEqual([["accept-language", acceptLanguage(discordLocale(locale()))]])
  })

  test("serves a number under 12 hours old without a request", async () => {
    saveCache(555, NOW - BUILD_TTL_MS + 1)
    expect(await lookup()).toBe(555)
    expect(discord.requests).toHaveLength(0)
    expect(paces).toBe(0)
  })

  test("reads the page again after 12 hours", async () => {
    saveCache(555, NOW - BUILD_TTL_MS)
    discord.buildNumber = 777
    expect(await lookup()).toBe(777)
    expect(saved()).toEqual({ number: 777, fetchedAt: NOW })
  })

  test("finds the number in either form", async () => {
    discord.loginPage = '<script>window.GLOBAL_ENV={"BUILD_NUMBER": 424242}</script>'
    expect(await lookup()).toBe(424242)
    discord.loginPage = '<script src="a.js"></script><script>x={build_number:"313131"}</script>'
    expect(await lookup(NOW + BUILD_TTL_MS)).toBe(313131)
  })

  test("serves a stale number under 7 days old when the refresh fails", async () => {
    const age = BUILD_STALE_OK_MS - 1
    for (const fail of [
      () => discord.failNext({ dispatched: true }),
      () => (discord.loginStatus = 503),
      () => (discord.buildNumber = undefined),
    ]) {
      discord = new FakeDiscord()
      saveCache(555, NOW - age)
      fail()
      expect(await lookup()).toBe(555)
      expect((saved() as { fetchedAt: number }).fetchedAt).toBe(NOW - age)
    }
  })

  test("refuses to serve a number 7 days old when the refresh fails", async () => {
    saveCache(555, NOW - BUILD_STALE_OK_MS)
    discord.buildNumber = undefined
    await expect(lookup()).rejects.toMatchObject({
      code: "upstream_error",
      message: "Could not read Discord's current client build number; no request was sent.",
    })
  })

  test("fails without a cache when the page has no number", async () => {
    discord.buildNumber = undefined
    await expect(lookup()).rejects.toMatchObject({ code: "upstream_error" })
    expect(() => saved()).toThrow()
  })

  test("ignores a malformed cache", async () => {
    mkdirSync(stateDir, { recursive: true })
    for (const text of ["", "x", "[]", '{"number":"1","fetchedAt":1}', `{"number":5,"fetchedAt":${NOW + 1000}}`]) {
      writeFileSync(join(stateDir, "build.json"), text)
      discord.buildNumber = 99
      expect(await lookup()).toBe(99)
    }
  })

  test("lets a failure that is not a transport failure through", async () => {
    const error = new Error("boom")
    await expect(
      buildNumber({
        stateDir,
        transport: async () => {
          throw error
        },
        now: () => NOW,
        pace: async () => {},
      }),
    ).rejects.toBe(error)
  })

  test("still answers when the cache cannot be saved", async () => {
    writeFileSync(stateDir, "a file where the directory should be")
    expect(await lookup()).toBe(100_000)
  })
})
