import { describe, expect, test } from "bun:test"
import type { RoleSnapshot, StoredRole } from "../discord/mirror-roles"
import { SERVER } from "../discord/objects.testing"
import { ADMINISTRATOR, ALL_PERMISSIONS, MANAGE_ROLES, permissionNames } from "./permissions"
import { standingOf } from "./standing"

const [BOSS, HELPER, TIE, BOT, LOW] = [
  "1400000000000000701",
  "1400000000000000702",
  "1400000000000000703",
  "1400000000000000704",
  "1400000000000000705",
]

const SEND = 1n << 11n
const KICK = 1n << 1n

const role = (id: string, position: number, permissions = 0n, managed = false): StoredRole => ({
  id,
  name: `role ${id.slice(-2)}`,
  position,
  permissions,
  managed,
})

const roles = [
  role(BOSS, 9, MANAGE_ROLES),
  role(BOT, 8, 0n, true),
  role(HELPER, 5, KICK),
  role(TIE, 5),
  role(LOW, 2),
  role(SERVER, 0, SEND),
]

const snapshot = (ownRoles: string[]): RoleSnapshot => ({ server: SERVER, roles, ownRoles, readAt: 1 })
const byId = (id: string) => roles.find((entry) => entry.id === id)!

describe("standingOf", () => {
  test("joins @everyone's permissions and every held role's", () => {
    const standing = standingOf(snapshot([HELPER, TIE]), false)
    expect(standing.permissions).toBe(SEND | KICK)
    expect(standing.held.map(({ id }) => id)).toEqual([HELPER, TIE])
    expect(standing.topPosition).toBe(5)
    expect(standing.canManageRoles).toBe(false)
  })

  test("takes @everyone alone for a user with no role, at position 0", () => {
    const standing = standingOf(snapshot([]), false)
    expect(standing.permissions).toBe(SEND)
    expect(standing.held).toEqual([])
    expect(standing.topPosition).toBe(0)
  })

  test("leaves out an own role the snapshot does not list, and the server's own id", () => {
    const standing = standingOf(snapshot(["1400000000000000799", SERVER, LOW]), false)
    expect(standing.held.map(({ id }) => id)).toEqual([LOW])
  })

  test("gives an owner every named permission", () => {
    const standing = standingOf(snapshot([]), true)
    expect(standing.permissions).toBe(ALL_PERMISSIONS)
    expect(standing.canManageRoles).toBe(true)
    expect(permissionNames(standing.permissions)).toContain("ban_members")
  })

  test("gives a holder of administrator every named permission", () => {
    const withAdmin = [role(HELPER, 5, ADMINISTRATOR), role(SERVER, 0)]
    const standing = standingOf({ server: SERVER, roles: withAdmin, ownRoles: [HELPER], readAt: 1 }, false)
    expect(standing.permissions).toBe(ALL_PERMISSIONS)
    expect(standing.canManageRoles).toBe(true)
  })

  test("takes manage_roles from @everyone too", () => {
    const open = [role(SERVER, 0, MANAGE_ROLES), role(LOW, 2)]
    expect(standingOf({ server: SERVER, roles: open, ownRoles: [], readAt: 1 }, false).canManageRoles).toBe(true)
  })
})

describe("manageable", () => {
  test("is a role strictly below the user's highest, for a user who may manage roles", () => {
    const standing = standingOf(snapshot([BOSS]), false)
    expect(standing.canManageRoles).toBe(true)
    expect(standing.topPosition).toBe(9)
    expect(standing.manageable(byId(HELPER))).toBe(true)
    expect(standing.manageable(byId(LOW))).toBe(true)
  })

  test("is not a role at the user's own position, nor above it", () => {
    const standing = standingOf(snapshot([BOSS, HELPER]), false)
    expect(standing.manageable(byId(BOSS))).toBe(false)
    const mid = standingOf(
      {
        server: SERVER,
        roles: [role(HELPER, 5, MANAGE_ROLES), role(TIE, 5), role(BOT, 8)],
        ownRoles: [HELPER],
        readAt: 1,
      },
      false,
    )
    expect(mid.manageable(role(TIE, 5))).toBe(false)
    expect(mid.manageable(role(BOT, 8))).toBe(false)
    expect(mid.manageable(role(LOW, 4))).toBe(true)
  })

  test("is not a role an integration manages, nor @everyone", () => {
    const standing = standingOf(snapshot([BOSS]), false)
    expect(standing.manageable(byId(BOT))).toBe(false)
    expect(standing.manageable(byId(SERVER))).toBe(false)
  })

  test("is nothing for a user who may not manage roles", () => {
    const standing = standingOf(snapshot([HELPER]), false)
    expect(standing.manageable(byId(LOW))).toBe(false)
  })

  test("exempts an owner from the hierarchy, but not from managed roles or @everyone", () => {
    const standing = standingOf(snapshot([LOW]), true)
    expect(standing.manageable(byId(BOSS))).toBe(true)
    expect(standing.manageable(byId(LOW))).toBe(true)
    expect(standing.manageable(byId(BOT))).toBe(false)
    expect(standing.manageable(byId(SERVER))).toBe(false)
  })
})
