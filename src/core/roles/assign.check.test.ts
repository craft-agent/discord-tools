import { afterEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ROLE_SNAPSHOT_MAX_AGE_MS } from "../discord/mirror-roles"
import { ALICE, BOB, SERVER } from "../discord/objects.testing"
import { seedUsers } from "../people/people.testing"
import { type AssignFixture, BIT47, createAssignFixture, HIGH, PEER, STRANGER, WEAK_ADMIN } from "./assign.testing"
import { ADMIN, BOT, HELPER, MOD, TIE_A } from "./roles.testing"

let f: AssignFixture

afterEach(() => f.dispose())

/** Both tools, so each check is shown to refuse giving and taking alike where it applies to both. */
const both = [
  ["assign", (role: string) => f.assign({ role })],
  ["unassign", (role: string) => f.unassign({ role })],
] as const

describe("what is refused before any request", () => {
  test("a server the mirror does not know", async () => {
    f = await createAssignFixture()
    expect(await failure(f.assign({ server: "1400000000000000999" }))).toMatchObject({ code: "not_found" })
    expect(f.discord.api).toEqual([])
  })

  test("a server whose roles were never read, saying to read them", async () => {
    f = await createAssignFixture({ stored: false })
    const error = await failure(f.assign())
    expect(error).toMatchObject({
      code: "not_found",
      message: expect.stringContaining("discord_role_read method list"),
    })
    expect(f.discord.api).toEqual([])
  })

  test("a snapshot older than 15 minutes, saying to read the roles again; exactly 15 minutes is still fine", async () => {
    f = await createAssignFixture()
    f.advance(ROLE_SNAPSHOT_MAX_AGE_MS)
    f.discord.route("PUT", `/guilds/${SERVER}/members/${ALICE}/roles/${TIE_A}`, { status: 204 })
    await f.assign()
    f.advance(1)
    const error = await failure(f.assign())
    expect(error).toMatchObject({ code: "stale", message: expect.stringContaining("Read them again") })
    expect(f.writes()).toHaveLength(1)
  })

  test.each(both)("%s: a role the snapshot does not list", async (_, call) => {
    f = await createAssignFixture()
    expect(await failure(call("1400000000000000999"))).toMatchObject({ code: "not_found" })
    expect(f.discord.api).toEqual([])
  })

  test.each(both)("%s: a user who may not manage roles", async (_, call) => {
    f = await createAssignFixture({ held: [HELPER] })
    expect(await failure(call(TIE_A))).toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Manage Roles"),
    })
    expect(f.discord.api).toEqual([])
  })

  test.each(both)("%s: @everyone", async (_, call) => {
    f = await createAssignFixture()
    expect(await failure(call(SERVER))).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("@everyone"),
    })
    expect(f.discord.api).toEqual([])
  })

  test.each(both)("%s: a role an integration manages", async (_, call) => {
    f = await createAssignFixture({ owner: true, held: [] })
    expect(await failure(call(BOT))).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("integration"),
    })
    expect(f.discord.api).toEqual([])
  })

  test.each(both)("%s: a role above, or as high as, the user's highest", async (_, call) => {
    f = await createAssignFixture()
    for (const role of [PEER, HIGH, ADMIN]) {
      expect(await failure(call(role))).toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("not below"),
      })
    }
    expect(f.discord.api).toEqual([])
  })

  test("giving a role that holds administrator, even to an owner", async () => {
    f = await createAssignFixture({ owner: true, held: [] })
    for (const role of [ADMIN, WEAK_ADMIN]) {
      expect(await failure(f.assign({ role }))).toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("administrator"),
      })
    }
    expect(f.discord.api).toEqual([])
  })

  test("giving a role with a permission the user lacks, naming it", async () => {
    f = await createAssignFixture()
    const error = await failure(f.assign({ role: HELPER }))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("manage_messages")
    expect(error.message).not.toContain("kick_members")
    expect(f.discord.api).toEqual([])
  })

  test("a user the mirror does not know, naming it, even when another is known", async () => {
    f = await createAssignFixture()
    const error = await failure(f.assign({ users: [ALICE, STRANGER] }))
    expect(error).toMatchObject({ code: "not_found", message: expect.stringContaining(STRANGER) })
    expect((await failure(f.unassign({ user: STRANGER }))).message).toContain(STRANGER)
    expect(f.discord.api).toEqual([])
  })

  test.each([
    ["no users", { users: [] }],
    ["a user twice", { users: [ALICE, BOB, ALICE] }],
    ["31 users", { users: Array.from({ length: 31 }, (_, i) => String(1_400_000_000_000_001_000n + BigInt(i))) }],
    ["a name for a user", { users: ["alice"] }],
    ["a name for the server", { server: "general" }],
    ["a name for the role", { role: "helper" }],
    ["a blank reason", { reason: "  \n" }],
    ["a reason of 513 characters", { reason: "x".repeat(513) }],
    ["an unknown argument", { silent: true }],
  ])("%s is an invalid argument", async (_, args) => {
    f = await createAssignFixture()
    expect(await failure(f.assign(args))).toMatchObject({ code: "invalid_argument" })
    expect(f.discord.api).toEqual([])
  })

  test("unassign takes one user and no list", async () => {
    f = await createAssignFixture()
    expect(await failure(f.unassign({ users: [ALICE] }))).toMatchObject({ code: "invalid_argument" })
    expect(f.discord.api).toEqual([])
  })
})

describe("what is allowed", () => {
  test("30 distinct users in one request, and a reason of 512 characters", async () => {
    f = await createAssignFixture()
    const users = Array.from({ length: 30 }, (_, i) => String(1_400_000_000_000_001_000n + BigInt(i)))
    seedUsers(f, ...users)
    f.discord.route("PATCH", `/guilds/${SERVER}/roles/${TIE_A}/members`, { status: 200, json: {} })
    await f.assign({ users, reason: "x".repeat(512) })
    expect(f.writes()).toHaveLength(1)
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ member_ids: users })
  })

  test("an owner gives and takes roles above any of their own, but not administrator", async () => {
    f = await createAssignFixture({ owner: true, held: [] })
    f.discord.route("PUT", `/guilds/${SERVER}/members/${ALICE}/roles/${MOD}`, { status: 204 })
    f.discord.route("DELETE", `/guilds/${SERVER}/members/${ALICE}/roles/${ADMIN}`, { status: 204 })
    expect(await f.assign({ role: MOD })).toMatchObject({ given: true })
    expect(await f.unassign({ role: ADMIN })).toMatchObject({ given: false })
  })

  test("a user with administrator gives any role below theirs, bit 47 with no name included", async () => {
    f = await createAssignFixture({ held: [ADMIN] })
    for (const role of [HELPER, BIT47]) {
      f.discord.route("PUT", `/guilds/${SERVER}/members/${ALICE}/roles/${role}`, { status: 204 })
      expect(await f.assign({ role })).toMatchObject({ given: true })
    }
  })

  test("taking a role away needs none of the permissions it holds", async () => {
    f = await createAssignFixture()
    f.discord.route("DELETE", `/guilds/${SERVER}/members/${ALICE}/roles/${HELPER}`, { status: 204 })
    expect(await f.unassign({ role: HELPER })).toMatchObject({ given: false })
  })
})
