import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ALICE, BOB, SERVER, userObject } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { memberPath } from "./member"
import {
  createPeopleFixture,
  type PeopleFixture,
  requestsOf,
  seedServers,
  seedUsers,
  storedUsersOf,
} from "./people.testing"
import { rolesPath } from "./role-list"

const OTHER_SERVER = "1400000000000000101"
const [ADMIN, MOD, GONE] = ["1400000000000000501", "1400000000000000502", "1400000000000000599"]
const [TIE_A, TIE_B] = ["1400000000000000510", "1400000000000000511"]

const roles = [
  { id: SERVER, name: "@everyone", position: 0 },
  { id: MOD, name: "Moderator", position: 3 },
  { id: ADMIN, name: "Admin", position: 9 },
  { id: TIE_B, name: "Tie B", position: 1 },
  { id: TIE_A, name: "Tie A", position: 1 },
]

let f: PeopleFixture
beforeEach(async () => {
  f = await createPeopleFixture()
  seedUsers(f, ALICE)
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const member = (extra: Record<string, unknown> = {}) => ({
  user: userObject(ALICE, { username: "alice", global_name: "Alice L" }),
  nick: null,
  joined_at: "2025-01-02T03:04:05.000000+00:00",
  roles: [],
  ...extra,
})
const serve = (body: unknown, list: unknown = roles) =>
  f.discord
    .route("GET", memberPath(SERVER, ALICE), { status: 200, json: body })
    .route("GET", rolesPath(SERVER), { status: 200, json: list })
const read = (args: Record<string, unknown> = {}) =>
  f.people({ method: "member", user: ALICE, server: SERVER, ...args })

describe("the request", () => {
  test("is the member, then the server's roles, both GET with no query", async () => {
    serve(member())
    await read()
    expect(requestsOf(f)).toEqual([`GET ${memberPath(SERVER, ALICE)}`, `GET ${rolesPath(SERVER)}`])
    expect(f.discord.api.map((request) => [...request.query.keys()])).toEqual([[], []])
  })

  test("of a user the mirror does not know is not_found, and nothing is requested", async () => {
    const error = await failure(read({ user: BOB }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(BOB)
    expect(f.discord.api).toEqual([])
  })

  test("in a server the mirror does not know is not_found, and nothing is requested", async () => {
    const error = await failure(read({ server: OTHER_SERVER }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(OTHER_SERVER)
    expect(f.discord.api).toEqual([])
  })
})

describe("the result", () => {
  test("names the member's roles from the server's list, highest first, then by id", async () => {
    serve(member({ nick: "Al", roles: [TIE_B, MOD, TIE_A, ADMIN] }))
    expect((await read()).member).toEqual({
      server: SERVER,
      server_name: "Tea house",
      user: ALICE,
      name: "Al",
      username: "alice",
      nick: "Al",
      joined: "2025-01-02T03:04:05.000Z",
      roles: [
        { id: ADMIN, name: "Admin" },
        { id: MOD, name: "Moderator" },
        { id: TIE_A, name: "Tie A" },
        { id: TIE_B, name: "Tie B" },
      ],
    })
  })

  test("leaves @everyone out and keeps a role the server does not list, last, with a null name", async () => {
    serve(member({ roles: [GONE, SERVER, MOD, MOD, "x"] }))
    expect((await read()).member?.roles).toEqual([
      { id: MOD, name: "Moderator" },
      { id: GONE, name: null },
    ])
  })

  test("is named by the display name without a nickname, and has no join time Discord does not say", async () => {
    serve(member({ joined_at: null }))
    expect((await read()).member).toMatchObject({ name: "Alice L", nick: null, joined: null, roles: [] })
  })

  test("falls back to the mirror's names when Discord sends no user, and to the id when it has none", async () => {
    serve(member({ user: undefined }))
    expect((await read()).member).toMatchObject({ name: "user02", username: "user02" })
    f.seed((m) => m.prepare("UPDATE users SET username = NULL").run())
    expect((await read()).member).toMatchObject({ name: ALICE, username: null })
  })

  test("names the server null when the mirror holds it without a name", async () => {
    f.seed((m) => m.prepare("UPDATE servers SET name = NULL").run())
    serve(member())
    expect((await read()).member?.server_name).toBeNull()
  })

  test("says the names are people's words, that nothing but the user name was stored", async () => {
    serve(member())
    const { note } = await read()
    expect(note).toContain("Nothing but the user name was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })

  test("stores the member's user object and nothing else", async () => {
    serve(member({ user: userObject(ALICE, { username: "alice-new" }) }))
    await read()
    expect(storedUsersOf(f)).toEqual([ALICE])
    expect((await read()).member?.username).toBe("alice-new")
  })
})

describe("Discord's answer", () => {
  test("404 for the member is not_found, saying the user is not a member of that server, and asks no roles", async () => {
    f.discord.route("GET", memberPath(SERVER, ALICE), { status: 404, json: { code: 10007, message: "Unknown Member" } })
    const error = await failure(read())
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(`User ${ALICE} is not a member of server ${SERVER}`)
    expect(error.message).toContain("Unknown Member")
    expect(error.details).toEqual({ discord_code: 10007 })
    expect(requestsOf(f)).toEqual([`GET ${memberPath(SERVER, ALICE)}`])
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [500, "upstream_error"],
  ])("%d for the member is %s, as it is", async (status, code) => {
    f.discord.route("GET", memberPath(SERVER, ALICE), { status, json: { code: 0, message: "refused" } })
    const error = await failure(read())
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("is not a member")
  })

  test("404 for the roles is not_found as it is", async () => {
    f.discord.route("GET", memberPath(SERVER, ALICE), { status: 200, json: member() })
    const error = await failure(read())
    expect(error.code).toBe("not_found")
    expect(error.message).not.toContain("is not a member")
  })

  test.each([
    ["a member that is an array", [], roles],
    ["a member that is null", null, roles],
    ["roles that are an object", member(), {}],
    ["roles with an entry that is no object", member(), [...roles, "x"]],
    ["roles that are null", member(), null],
  ])("%s is an upstream error, and stores nothing", async (_name, body, list) => {
    serve(body, list)
    expect((await failure(read({ user: ALICE }))).code).toBe("upstream_error")
    expect(storedUsersOf(f)).toEqual([ALICE])
  })

  test("roles with an entry without an id are read without it", async () => {
    serve(member({ roles: [MOD] }), [{ name: "no id", position: 5 }, ...roles])
    expect((await read()).member?.roles).toEqual([{ id: MOD, name: "Moderator" }])
  })
})
