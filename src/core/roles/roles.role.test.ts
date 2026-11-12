import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { readRoleSnapshot } from "../discord/mirror-roles"
import { SERVER } from "../discord/objects.testing"
import { requestsOf } from "../people/people.testing"
import { rolesPath } from "../people/role-list"
import { roleCountsPath } from "../servers/roles"
import { ownMemberPath } from "./live"
import {
  ADMIN,
  createRoleFixture,
  HELPER,
  MOD,
  roleObject,
  type RoleFixture,
  SERVER_ROLES,
  serveRoles,
} from "./roles.testing"
import type { RoleDetail } from "./schemas"

let f: RoleFixture
beforeEach(async () => {
  f = await createRoleFixture()
})
afterEach(async () => {
  await f.dispose()
})

const readRole = (role: string) => f.roles({ method: "role", server: SERVER, role })

describe("method role", () => {
  test("asks what list asks and gives the one role with every permission by name", async () => {
    serveRoles(f, [HELPER])
    const result = await readRole(MOD)
    expect(requestsOf(f)).toEqual([
      `GET ${rolesPath(SERVER)}`,
      `GET ${roleCountsPath(SERVER)}`,
      `GET ${ownMemberPath(SERVER)}`,
    ])
    expect(result.roles).toBeUndefined()
    expect(result.role).toEqual({
      id: MOD,
      name: "Moderator",
      position: 5,
      color: "#1abc9c",
      members: 3,
      hoist: true,
      mentionable: false,
      managed: false,
      everyone: false,
      strong: ["kick_members", "manage_roles"],
      manageable: false,
      permissions: ["kick_members", "manage_roles"],
    })
    expect(result.you).toMatchObject({ roles: [{ id: HELPER, name: "Helper" }], manage_roles: false })
    expect(result.server_name).toBe("Tea house")
    expect(result.counts_missing).toBe(false)
  })

  test("names a bit with no flag as bit{n} and keeps bits above 2^53 exact", async () => {
    const everyBit = "18446744073709551615"
    serveRoles(f, [MOD], [...SERVER_ROLES, roleObject("1400000000000000850", 2, { permissions: everyBit })])
    const { role } = await readRole("1400000000000000850")
    const names = (role as RoleDetail).permissions
    expect(names).toContain("bit47")
    expect(names).toContain("bit63")
    expect(names).toContain("bypass_slowmode")
    expect(names).toHaveLength(64)
  })

  test("gives @everyone like any role", async () => {
    serveRoles(f)
    expect((await readRole(SERVER)).role).toMatchObject({
      id: SERVER,
      everyone: true,
      permissions: ["send_messages"],
      manageable: false,
    })
  })

  test("refreshes the snapshot the way list does", async () => {
    serveRoles(f, [MOD])
    const result = await readRole(ADMIN)
    const snapshot = f.inspect((m) => readRoleSnapshot(m, SERVER))!
    expect(snapshot.roles).toHaveLength(SERVER_ROLES.length)
    expect(snapshot.ownRoles).toEqual([MOD])
    expect(result.read_at).toBe(new Date(snapshot.readAt).toISOString())
  })

  test("is not_found for a role the server does not list, after refreshing the snapshot", async () => {
    serveRoles(f)
    const error = await failure(readRole("1400000000000000999"))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("method list")
    expect(f.inspect((m) => readRoleSnapshot(m, SERVER))).not.toBeNull()
  })

  test("asks nothing for a server the mirror does not know", async () => {
    const error = await failure(f.roles({ method: "role", server: "1400000000000000999", role: MOD }))
    expect(error.code).toBe("not_found")
    expect(f.discord.api).toEqual([])
  })
})
