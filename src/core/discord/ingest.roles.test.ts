import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestRoleSnapshot } from "./ingest"
import { createTestMirror, rowById, rowsOf, type TestMirror } from "./mirror.testing"
import { readRoleSnapshot, serverOwned, storedRole } from "./mirror-roles"
import { ctxAt, NOW, SERVER } from "./objects.testing"

const OTHER_SERVER = "1400000000000000101"
const [ADMIN, MOD, GONE, OTHER_ROLE] = [
  "1400000000000000601",
  "1400000000000000602",
  "1400000000000000603",
  "1400000000000000604",
]

/** All 64 bits set: a permission set only a BigInt keeps exact. */
const EVERY_BIT = "18446744073709551615"

const role = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `role ${id.slice(-2)}`,
  position: 1,
  permissions: "1024",
  managed: false,
  ...extra,
})

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

const snapshot = (server: string, roles: unknown[], own: string[] = [], now = NOW) =>
  t.write(() => ingestRoleSnapshot(t.mirror, ctxAt(now), server, roles, own))

describe("ingestRoleSnapshot", () => {
  test("stores each role with its raw object, ids and permissions exact above 2^53", () => {
    const admin = role(ADMIN, { position: 9, permissions: EVERY_BIT, managed: true })
    const counts = snapshot(SERVER, [role(SERVER, { name: "@everyone", position: 0 }), admin], [ADMIN])
    expect(counts).toEqual({ stored: 2, deleted: 0, skipped: 0 })
    expect(rowById(t.mirror, "roles", ADMIN)).toMatchObject({
      id: ADMIN,
      server: SERVER,
      name: "role 01",
      position: 9,
      permissions: EVERY_BIT,
      managed: 1,
      raw: JSON.stringify(admin),
      updated: NOW,
    })
    expect(rowsOf(t.mirror, "SELECT CAST(server AS TEXT) AS server, own_roles, read_at FROM role_snapshots")).toEqual([
      { server: SERVER, own_roles: JSON.stringify([ADMIN]), read_at: NOW },
    ])
  })

  test("replaces the server's list: a role not returned is deleted, the others are updated", () => {
    snapshot(SERVER, [role(MOD), role(GONE)], [MOD, GONE])
    const counts = snapshot(SERVER, [role(MOD, { name: "Renamed", permissions: "8" })], [MOD], NOW + 1)
    expect(counts).toEqual({ stored: 1, deleted: 1, skipped: 0 })
    expect(rowById(t.mirror, "roles", GONE)).toBeUndefined()
    expect(rowById(t.mirror, "roles", MOD)).toMatchObject({ name: "Renamed", permissions: "8", updated: NOW + 1 })
    expect(readRoleSnapshot(t.mirror, SERVER)).toMatchObject({ ownRoles: [MOD], readAt: NOW + 1 })
  })

  test("leaves another server's roles and snapshot alone", () => {
    snapshot(OTHER_SERVER, [role(OTHER_ROLE)], [OTHER_ROLE])
    snapshot(SERVER, [role(MOD)], [MOD], NOW + 1)
    snapshot(SERVER, [], [], NOW + 2)
    expect(readRoleSnapshot(t.mirror, OTHER_SERVER)).toEqual({
      server: OTHER_SERVER,
      roles: [{ id: OTHER_ROLE, name: "role 04", position: 1, permissions: 1024n, managed: false }],
      ownRoles: [OTHER_ROLE],
      readAt: NOW,
    })
    expect(readRoleSnapshot(t.mirror, SERVER)).toMatchObject({ roles: [], ownRoles: [], readAt: NOW + 2 })
  })

  test("skips entries without a valid id or permission bit set, and counts them", () => {
    const entries = [
      role(MOD),
      { ...role(ADMIN), permissions: undefined },
      role(GONE, { permissions: "-1" }),
      role(OTHER_ROLE, { permissions: 8 }),
      role("12x"),
      null,
      "text",
    ]
    expect(snapshot(SERVER, entries)).toEqual({ stored: 1, deleted: 0, skipped: 6 })
    expect(rowsOf(t.mirror, "SELECT count(*) AS n FROM roles")).toEqual([{ n: 1 }])
  })

  test("stores each own role id once", () => {
    snapshot(SERVER, [role(MOD)], [MOD, MOD])
    expect(readRoleSnapshot(t.mirror, SERVER)?.ownRoles).toEqual([MOD])
  })
})

describe("readRoleSnapshot", () => {
  test("is null for a server never stored", () => {
    expect(readRoleSnapshot(t.mirror, SERVER)).toBeNull()
  })

  test("lists the roles highest first, then by id, with permissions as BigInt", () => {
    snapshot(SERVER, [
      role(MOD, { position: 3 }),
      role(ADMIN, { position: 9, permissions: EVERY_BIT }),
      role(GONE, { position: 3 }),
      role(SERVER, { position: 0 }),
    ])
    const stored = readRoleSnapshot(t.mirror, SERVER)!
    expect(stored.roles.map(({ id }) => id)).toEqual([ADMIN, MOD, GONE, SERVER])
    expect(stored.roles[0]!.permissions).toBe(18446744073709551615n)
  })
})

describe("storedRole", () => {
  test("reads a missing position as 0 and a missing name as null", () => {
    expect(storedRole({ id: MOD, permissions: "0" })).toEqual({
      id: MOD,
      name: null,
      position: 0,
      permissions: 0n,
      managed: false,
    })
  })
})

describe("serverOwned", () => {
  test("is true only for a server row flagged as owned", () => {
    t.mirror.exec(
      `INSERT INTO servers (id, owner, raw, updated) VALUES (${SERVER}, 1, '{}', 0), (${OTHER_SERVER}, 0, '{}', 0)`,
    )
    expect(serverOwned(t.mirror, SERVER)).toBe(true)
    expect(serverOwned(t.mirror, OTHER_SERVER)).toBe(false)
    expect(serverOwned(t.mirror, "1400000000000000102")).toBe(false)
  })
})
