import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { SERVER } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { requestsOf, seedServers } from "../people/people.testing"
import { rolesPath } from "../people/role-list"
import { roleCountsPath } from "./roles"
import { createServerFixture, type ServerFixture, storedServersOf } from "./servers.testing"

const [ADMIN, MOD, TIE_A, TIE_B] = [
  "1400000000000000501",
  "1400000000000000502",
  "1400000000000000510",
  "1400000000000000511",
]

let f: ServerFixture
beforeEach(async () => {
  f = await createServerFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const everyone = { id: SERVER, name: "@everyone", position: 0, color: 0, permissions: "1024" }
const roles = [
  everyone,
  { id: MOD, name: "Moderator", position: 3, color: 0x1abc9c, hoist: true, mentionable: true, permissions: "8192" },
  { id: ADMIN, name: "Admin", position: 9, color: 16777215, managed: true, permissions: "8" },
  { id: TIE_B, name: "Tie B", position: 1 },
  { id: TIE_A, name: "Tie A", position: 1 },
]
const counts = { [SERVER]: 40, [ADMIN]: 1, [MOD]: 3, [TIE_A]: 0 }

const serve = (list: unknown = roles, memberCounts: unknown = counts) =>
  f.discord
    .route("GET", rolesPath(SERVER), { status: 200, json: list })
    .route("GET", roleCountsPath(SERVER), { status: 200, json: memberCounts })
const read = () => f.servers({ method: "roles", server: SERVER })

describe("the request", () => {
  test("is the roles, then their member counts, both GET with no query", async () => {
    serve()
    await read()
    expect(requestsOf(f)).toEqual([`GET ${rolesPath(SERVER)}`, `GET ${roleCountsPath(SERVER)}`])
    expect(f.discord.api.map((request) => [...request.query.keys()])).toEqual([[], []])
  })
})

describe("the result", () => {
  test("lists every role highest first, then by id, with its count", async () => {
    serve()
    const result = await read()
    expect(result.roles?.map((role) => [role.name, role.position, role.members])).toEqual([
      ["Admin", 9, 1],
      ["Moderator", 3, 3],
      ["Tie A", 1, 0],
      ["Tie B", 1, null],
      ["@everyone", 0, 40],
    ])
    expect(result.count).toBe(5)
    expect(result.counts_missing).toBe(false)
  })

  test("maps a role's color, flags and permissions, and marks the @everyone role", async () => {
    serve()
    const byName = Object.fromEntries((await read()).roles!.map((role) => [role.name, role]))
    expect(byName["Moderator"]).toEqual({
      id: MOD,
      name: "Moderator",
      position: 3,
      color: "#1abc9c",
      hoist: true,
      mentionable: true,
      managed: false,
      everyone: false,
      members: 3,
      permissions: "8192",
    })
    expect(byName["Admin"]).toMatchObject({ color: "#ffffff", managed: true, hoist: false, everyone: false })
    expect(byName["@everyone"]).toMatchObject({ color: null, everyone: true, permissions: "1024" })
    expect(byName["Tie B"]).toMatchObject({ color: null, permissions: null })
  })

  test("has null counts for a count that is no count, and a color that is no color", async () => {
    serve(
      [
        { id: MOD, color: 16777216 },
        { id: ADMIN, color: -1 },
      ],
      { [MOD]: -1, [ADMIN]: "3" },
    )
    expect((await read()).roles).toMatchObject([
      { id: ADMIN, color: null, members: null },
      { id: MOD, name: null, position: 0, color: null, members: null },
    ])
  })

  test("leaves out a role without a valid id", async () => {
    serve([{ name: "no id", position: 5 }, ...roles])
    expect((await read()).count).toBe(5)
  })

  test("says the names are people's words and that nothing was stored", async () => {
    serve()
    const { note } = await read()
    expect(note).toContain("Nothing was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })

  test("writes nothing to the mirror", async () => {
    const before = storedServersOf(f)
    serve()
    await read()
    expect(storedServersOf(f)).toEqual(before)
  })
})

describe("Discord's answer", () => {
  test.each([403, 404])("%d for the member counts leaves the roles listed with no counts", async (status) => {
    f.discord
      .route("GET", rolesPath(SERVER), { status: 200, json: roles })
      .route("GET", roleCountsPath(SERVER), { status, json: { code: 0, message: "refused" } })
    const result = await read()
    expect(result.counts_missing).toBe(true)
    expect(result.count).toBe(5)
    expect(result.roles?.map((role) => role.members)).toEqual([null, null, null, null, null])
    expect(result.note).toContain("counts_missing")
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [500, "upstream_error"],
  ])("%d for the member counts is %s, as it is", async (status, code) => {
    f.discord
      .route("GET", rolesPath(SERVER), { status: 200, json: roles })
      .route("GET", roleCountsPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(read())).code).toBe(code)
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d for the roles is %s, and asks no counts", async (status, code) => {
    f.discord.route("GET", rolesPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(read())).code).toBe(code)
    expect(requestsOf(f)).toEqual([`GET ${rolesPath(SERVER)}`])
  })

  test.each([
    ["roles that are an object", {}, counts],
    ["roles that are null", null, counts],
    ["a role that is no object", [...roles, "x"], counts],
    ["counts that are an array", roles, []],
    ["counts that are null", roles, null],
  ])("%s is an upstream error", async (_name, list, memberCounts) => {
    serve(list, memberCounts)
    expect((await failure(read())).code).toBe("upstream_error")
  })
})
