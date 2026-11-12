import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { rowsOf } from "../discord/mirror.testing"
import { readRoleSnapshot } from "../discord/mirror-roles"
import { SERVER } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { requestsOf } from "../people/people.testing"
import { rolesPath } from "../people/role-list"
import { roleCountsPath } from "../servers/roles"
import { ownMemberPath } from "./live"
import {
  ADMIN,
  BOT,
  createRoleFixture,
  HELPER,
  MEMBER_COUNTS,
  MOD,
  roleObject,
  type RoleFixture,
  SERVER_ROLES,
  serveRoles,
  TIE_A,
  TIE_B,
} from "./roles.testing"

let f: RoleFixture
beforeEach(async () => {
  f = await createRoleFixture()
})
afterEach(async () => {
  await f.dispose()
})

const list = () => f.roles({ method: "list", server: SERVER })
const stored = () => f.inspect((m) => readRoleSnapshot(m, SERVER))

describe("the requests", () => {
  test("are the roles, their counts and the user's own membership, in that order, all GET", async () => {
    serveRoles(f)
    await list()
    expect(requestsOf(f)).toEqual([
      `GET ${rolesPath(SERVER)}`,
      `GET ${roleCountsPath(SERVER)}`,
      `GET ${ownMemberPath(SERVER)}`,
    ])
    expect(ownMemberPath(SERVER)).toBe(`/users/@me/guilds/${SERVER}/member`)
  })

  test("are not made for a server the mirror does not know", async () => {
    const error = await failure(f.roles({ method: "list", server: "1400000000000000999" }))
    expect(error.code).toBe("not_found")
    expect(f.discord.api).toEqual([])
  })
})

describe("the roles", () => {
  test("are listed highest first, then by id, with their counts", async () => {
    serveRoles(f)
    const result = await list()
    expect(result.roles?.map((role) => [role.id, role.position, role.members])).toEqual([
      [ADMIN, 9, 1],
      [BOT, 7, 1],
      [MOD, 5, 3],
      [HELPER, 3, 6],
      [TIE_A, 1, 0],
      [TIE_B, 1, null],
      [SERVER, 0, 40],
    ])
  })

  test("carry their color, flags, strong permissions and whether the user may manage them", async () => {
    serveRoles(f, [MOD])
    const byId = Object.fromEntries((await list()).roles!.map((role) => [role.id, role]))
    expect(byId[HELPER]).toEqual({
      id: HELPER,
      name: "Helper",
      position: 3,
      color: null,
      members: 6,
      hoist: false,
      mentionable: true,
      managed: false,
      everyone: false,
      strong: ["manage_messages"],
      manageable: true,
    })
    expect(byId[MOD]).toMatchObject({ color: "#1abc9c", hoist: true, strong: ["kick_members", "manage_roles"] })
    expect(byId[MOD]!.manageable).toBe(false)
    expect(byId[ADMIN]).toMatchObject({ strong: ["administrator"], manageable: false })
    expect(byId[BOT]).toMatchObject({ managed: true, manageable: false })
    expect(byId[SERVER]).toMatchObject({ everyone: true, strong: [], manageable: false })
  })

  test("leave out a role without a permission bit set", async () => {
    serveRoles(f, [MOD], [...SERVER_ROLES, roleObject("1400000000000000899", 2, { permissions: null })])
    expect((await list()).roles).toHaveLength(SERVER_ROLES.length)
  })
})

describe("where the user stands", () => {
  test("is their roles highest first without @everyone, the permissions they join and their top position", async () => {
    serveRoles(f, [HELPER, MOD, SERVER])
    const { you } = await list()
    expect(you).toEqual({
      owner: false,
      roles: [
        { id: MOD, name: "Moderator" },
        { id: HELPER, name: "Helper" },
      ],
      permissions: ["kick_members", "send_messages", "manage_messages", "manage_roles"],
      manage_roles: true,
      highest_position: 5,
    })
  })

  test("is every permission for an owner, who may manage every role but the managed and @everyone", async () => {
    await f.dispose()
    f = await createRoleFixture({ owner: true })
    serveRoles(f, [])
    const result = await list()
    expect(result.you).toMatchObject({ owner: true, manage_roles: true, highest_position: 0, roles: [] })
    expect(result.you?.permissions).toContain("ban_members")
    expect(result.roles?.filter((role) => role.manageable).map((role) => role.id)).toEqual([
      ADMIN,
      MOD,
      HELPER,
      TIE_A,
      TIE_B,
    ])
  })

  test("is manage_roles for none but the holder of it", async () => {
    serveRoles(f, [HELPER])
    const result = await list()
    expect(result.you?.manage_roles).toBe(false)
    expect(result.roles?.some((role) => role.manageable)).toBe(false)
  })
})

describe("the snapshot", () => {
  test("is stored with the roles, the user's own role ids and the time it was read, which the result gives", async () => {
    serveRoles(f, [MOD, HELPER])
    const result = await list()
    const snapshot = stored()!
    expect(snapshot.ownRoles).toEqual([MOD, HELPER])
    expect(snapshot.roles.map((role) => role.id)).toEqual(result.roles!.map((role) => role.id))
    expect(snapshot.roles.find((role) => role.id === ADMIN)?.permissions).toBe(8n)
    expect(result.read_at).toBe(new Date(snapshot.readAt).toISOString())
    expect(result.errors).toBeUndefined()
  })

  test("is replaced by the next read: a role Discord no longer lists is dropped", async () => {
    serveRoles(f)
    await list()
    serveRoles(
      f,
      [HELPER],
      SERVER_ROLES.filter((role) => role.id !== ADMIN),
    )
    await list()
    expect(stored()!.roles.map((role) => role.id)).not.toContain(ADMIN)
    expect(stored()!.ownRoles).toEqual([HELPER])
  })

  test("is not stored when a request fails, and a failure to store is reported with the read standing", async () => {
    f.discord
      .route("GET", rolesPath(SERVER), { status: 200, json: SERVER_ROLES })
      .route("GET", roleCountsPath(SERVER), { status: 200, json: MEMBER_COUNTS })
      .route("GET", ownMemberPath(SERVER), { status: 404, json: { code: 0, message: "Unknown Member" } })
    expect((await failure(list())).code).toBe("not_found")
    expect(stored()).toBeNull()

    serveRoles(f)
    f.seed((m) => m.exec("DROP TABLE role_snapshots"))
    const result = await list()
    expect(result.roles).toHaveLength(SERVER_ROLES.length)
    expect(Object.keys(result.errors ?? {})).toEqual(["store"])
    expect(result.errors?.store).toContain("role_snapshots")
    expect(f.inspect((m) => rowsOf(m, "SELECT id FROM roles"))).toEqual([])
  })
})

describe("the note", () => {
  test("says the snapshot is stored and how old role writes tolerate, and that names are people's words", async () => {
    serveRoles(f)
    const { note } = await list()
    expect(note).toContain("15 minutes")
    expect(note).toContain("snapshot")
    expect(note).toContain(UNTRUSTED_NOTE)
  })
})

describe("Discord's answer", () => {
  test.each([403, 404])("%d for the member counts lists the roles with no counts", async (status) => {
    serveRoles(f)
    f.discord.route("GET", roleCountsPath(SERVER), { status, json: { code: 0, message: "refused" } })
    const result = await list()
    expect(result.counts_missing).toBe(true)
    expect(result.roles?.map((role) => role.members)).toEqual(SERVER_ROLES.map(() => null))
    expect(stored()?.roles).toHaveLength(SERVER_ROLES.length)
  })

  test("is counts_missing false when Discord gave the counts", async () => {
    serveRoles(f)
    expect((await list()).counts_missing).toBe(false)
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [500, "upstream_error"],
  ])("%d for the roles is %s, and asks nothing more", async (status, code) => {
    f.discord.route("GET", rolesPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(list())).code).toBe(code)
    expect(requestsOf(f)).toEqual([`GET ${rolesPath(SERVER)}`])
  })

  test.each([
    ["roles that are an object", {}],
    ["a role that is no object", ["x"]],
  ])("%s is an upstream error", async (_name, roles) => {
    serveRoles(f, [MOD], roles)
    expect((await failure(list())).code).toBe("upstream_error")
  })

  test("a membership that is no object is an upstream error", async () => {
    serveRoles(f)
    f.discord.route("GET", ownMemberPath(SERVER), { status: 200, json: [] })
    expect((await failure(list())).code).toBe("upstream_error")
    expect(stored()).toBeNull()
  })
})
