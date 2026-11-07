import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getMeta, setMeta } from "../discord/mirror"
import { SERVER_LIST_AT_META } from "../discord/mirror-meta"
import { columnOf } from "../discord/mirror.testing"
import { CHANNEL, SERVER, serverObject } from "../discord/objects.testing"
import { UNTRUSTED_NOTE } from "./format"
import { SERVER_LIST_MS } from "./servers"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"

const SECOND = "1400000000000000101"
const THIRD = "1400000000000000102"
const MINUTE = 60 * 1000

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
})
afterEach(async () => {
  await f.dispose()
})

function guilds(...servers: unknown[]) {
  f.discord.route("GET", "/users/@me/guilds", { status: 200, json: servers })
}

const stamp = () => Number(f.inspect((m) => getMeta(m)[SERVER_LIST_AT_META]))

describe("method servers", () => {
  test("reads Discord when no list was stored, stores it and stamps the time", async () => {
    guilds(
      serverObject(SECOND, { name: "bravo", owner: true }),
      serverObject(SERVER, { name: "Alpha" }),
      serverObject(THIRD, { name: "alpha" }),
    )
    const started = f.now()
    const result = await f.read({ method: "servers" })
    expect(result.method).toBe("servers")
    expect(result.source).toBe("live")
    expect(result.note).toBe(UNTRUSTED_NOTE)
    expect(result.servers).toEqual([
      { id: SERVER, name: "Alpha", owner: false, followed: null },
      { id: THIRD, name: "alpha", owner: false, followed: null },
      { id: SECOND, name: "bravo", owner: true, followed: null },
    ])
    expect(f.discord.api).toHaveLength(1)
    expect(f.discord.api[0]!.query.get("with_counts")).toBe("false")
    expect(stamp()).toBeGreaterThanOrEqual(started)
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM servers"))).toEqual([3])
  })

  test("serves the mirror for under six hours, with no request and no token", async () => {
    guilds(serverObject(SERVER))
    await f.read({ method: "servers" })
    f.ctx.runtime!.env = {}
    f.advance(SERVER_LIST_MS - MINUTE)
    const result = await f.read({ method: "servers" })
    expect(result.source).toBe("mirror")
    expect(result.servers?.map((server) => server.id)).toEqual([SERVER])
    expect(f.discord.api).toHaveLength(1)
  })

  test("reads Discord again after six hours, and a server left drops out without being deleted", async () => {
    guilds(serverObject(SERVER, { name: "one" }), serverObject(SECOND, { name: "two" }))
    await f.read({ method: "servers" })
    guilds(serverObject(SERVER, { name: "one" }))
    f.advance(SERVER_LIST_MS + MINUTE)
    const result = await f.read({ method: "servers" })
    expect(result.source).toBe("live")
    expect(result.servers?.map((server) => server.id)).toEqual([SERVER])
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM servers"))).toEqual([2])
    expect(f.discord.api).toHaveLength(2)
  })

  test("refresh reads Discord even when the list is recent", async () => {
    guilds(serverObject(SERVER))
    await f.read({ method: "servers" })
    guilds(serverObject(SERVER), serverObject(SECOND))
    const result = await f.read({ method: "servers", refresh: true })
    expect(result.source).toBe("live")
    expect(result.servers).toHaveLength(2)
    expect((await f.read({ method: "servers", refresh: false })).source).toBe("mirror")
  })

  test("a stamp from the future does not keep the mirror in use", async () => {
    guilds(serverObject(SERVER))
    f.seed((m) => setMeta(m, { [SERVER_LIST_AT_META]: f.now() + 5 * MINUTE }))
    expect((await f.read({ method: "servers" })).source).toBe("live")
  })

  test("says how the sync list follows each server", async () => {
    guilds(serverObject(SERVER, { name: "a" }), serverObject(SECOND, { name: "b" }), serverObject(THIRD, { name: "c" }))
    await f.writeSyncList({ servers: [{ id: SERVER }, { id: SECOND, channels: [CHANNEL] }] })
    const result = await f.read({ method: "servers" })
    expect(result.servers?.map((server) => server.followed)).toEqual(["server", "channels", null])
  })

  test("a malformed answer is an upstream error and stores nothing", async () => {
    for (const json of [{ message: "oops" }, [serverObject(SERVER), serverObject(SERVER)], [{ name: "no id" }]]) {
      f.discord.route("GET", "/users/@me/guilds", { status: 200, json })
      const error = await failure(f.read({ method: "servers" }))
      expect(error.code).toBe("upstream_error")
    }
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM servers"))).toEqual([0])
    expect(f.inspect((m) => getMeta(m)[SERVER_LIST_AT_META])).toBeUndefined()
  })

  test("a rejected request fails with Discord's code and stores nothing", async () => {
    f.discord.route("GET", "/users/@me/guilds", { status: 403, json: { code: 50001, message: "Missing Access" } })
    expect((await failure(f.read({ method: "servers" }))).code).toBe("forbidden")
    expect(f.inspect((m) => columnOf(m, "SELECT count(*) FROM servers"))).toEqual([0])
  })
})
