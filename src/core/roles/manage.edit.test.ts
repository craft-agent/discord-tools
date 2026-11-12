import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { headerOf } from "../discord/fake-discord.testing"
import { SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { ASSIGN_ROLES, BIT47 } from "./assign.testing"
import { ROLE_EDITED_HELD_NOTE, ROLE_EDITED_NOTE } from "./manage"
import { editedRole, KICK_MEMBERS, type ManageFixture, createManageFixture, SEND_MESSAGES } from "./manage.testing"
import { discordRoleEdit } from "./manage-tool"
import { rolePath } from "./manage-plan"
import { ADMIN, HELPER, MOD, roleObject, TIE_A } from "./roles.testing"

let f: ManageFixture

beforeEach(async () => {
  f = await createManageFixture({ held: [MOD, HELPER] })
})

afterEach(() => f.dispose())

/** The stored roles with `TIE_A` replaced by one that has `extra`. */
const withTie = (extra: Record<string, unknown>) => [
  ...ASSIGN_ROLES.filter((role) => role.id !== TIE_A),
  roleObject(TIE_A, 1, extra),
]

const stored = (id: string) => f.snapshot()!.roles.find((role) => role.id === id)

describe("editing a role", () => {
  test("patches only the name, once, from the server's page, and stores the role Discord answers with", async () => {
    f.serveEdit(editedRole({ name: "Tea" }))
    const before = f.snapshot()!
    expect(await f.edit({ name: "Tea" })).toEqual({
      server: SERVER,
      role: { id: TIE_A, name: "Tea", position: 1 },
      changed: ["name"],
      permissions: [],
      note: ROLE_EDITED_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PATCH", path: rolePath(SERVER, TIE_A) })
    expect(JSON.parse(request!.body!)).toEqual({ name: "Tea" })
    expect(headerOf(request!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
    expect(headerOf(request!, "x-audit-log-reason")).toBeUndefined()
    expect(stored(TIE_A)).toMatchObject({ name: "Tea" })
    expect(f.snapshot()).toMatchObject({ readAt: before.readAt, ownRoles: before.ownRoles })
  })

  test("leaves out every given value that equals the stored one, and sends the reason", async () => {
    f.store(withTie({ color: 0x1abc9c, hoist: true }))
    f.serveEdit(editedRole({ color: 0x1abc9c, hoist: true, mentionable: true }))
    const result = await f.edit({
      name: "role 810",
      color: "#1ABC9C",
      hoist: true,
      mentionable: true,
      reason: "tidy: up",
    })
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ mentionable: true })
    expect(result.changed).toEqual(["mentionable"])
    expect(headerOf(f.writes()[0]!, "x-audit-log-reason")).toBe("tidy%3A up")
  })

  test("sends a color as its number, and none as 0", async () => {
    f.serveEdit()
    await f.edit({ color: "#1abc9c" })
    f.store(withTie({ color: 0x1abc9c }))
    await f.edit({ color: "none" })
    expect(f.writes().map((request) => JSON.parse(request.body!))).toEqual([{ color: 0x1abc9c }, { color: 0 }])
  })

  test("sends a flag taken back as false", async () => {
    f.store(withTie({ hoist: true, mentionable: true }))
    f.serveEdit()
    expect((await f.edit({ hoist: false, mentionable: false })).changed).toEqual(["hoist", "mentionable"])
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ hoist: false, mentionable: false })
  })

  test("sends the whole new permission set, keeping the bits that have no name", async () => {
    f.store([...ASSIGN_ROLES, roleObject(BIT47, 2, { permissions: String((1n << 47n) | SEND_MESSAGES) })])
    f.serveEdit(roleObject(BIT47, 2), BIT47)
    await f.edit({ role: BIT47, grant: ["kick_members"], revoke: ["send_messages"] })
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ permissions: String((1n << 47n) | KICK_MEMBERS) })
  })

  test("takes a grant of what the role holds and a revoke of what it lacks as no change to the permissions", async () => {
    f.store(withTie({ permissions: String(SEND_MESSAGES) }))
    f.serveEdit()
    const result = await f.edit({ name: "Tea", grant: ["send_messages"], revoke: ["kick_members"] })
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ name: "Tea" })
    expect(result.changed).toEqual(["name"])
  })

  test("names the permissions the role holds after the edit, as Discord answers", async () => {
    f.serveEdit(editedRole({ permissions: String(SEND_MESSAGES | KICK_MEMBERS) }))
    expect((await f.edit({ grant: ["send_messages", "kick_members"] })).permissions).toEqual([
      "kick_members",
      "send_messages",
    ])
    expect(stored(TIE_A)!.permissions).toBe(SEND_MESSAGES | KICK_MEMBERS)
  })

  test("revokes a permission the user lacks, and edits a role that holds administrator", async () => {
    f.store([...ASSIGN_ROLES, roleObject(BIT47, 2, { permissions: String(8n | (1n << 13n)) })])
    f.serveEdit(roleObject(BIT47, 2), BIT47)
    await f.edit({ role: BIT47, revoke: ["manage_messages"] })
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ permissions: "8" })
  })

  test("edits only the permissions of @everyone, and expires the snapshot since the user holds it", async () => {
    f.serveEdit(roleObject(SERVER, 0, { name: "@everyone", permissions: String(KICK_MEMBERS) }), SERVER)
    const result = await f.edit({ role: SERVER, grant: ["kick_members"], revoke: ["send_messages"] })
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({ permissions: String(KICK_MEMBERS) })
    expect(result).toMatchObject({ changed: ["permissions"], note: ROLE_EDITED_HELD_NOTE })
    expect(f.snapshot()).toMatchObject({ readAt: 0 })
    expect(stored(SERVER)).toMatchObject({ permissions: SEND_MESSAGES })
  })

  test("expires the snapshot instead of storing a role the user holds", async () => {
    f.serveEdit(roleObject(HELPER, 3, { name: "Tea" }), HELPER)
    const result = await f.edit({ role: HELPER, name: "Tea" })
    expect(result.note).toBe(ROLE_EDITED_HELD_NOTE)
    expect(f.snapshot()).toMatchObject({ readAt: 0 })
    expect(stored(HELPER)).toMatchObject({ name: "Helper" })
  })

  test("lets an owner edit a role above any of their own", async () => {
    await f.dispose()
    f = await createManageFixture({ owner: true, held: [] })
    f.serveEdit(roleObject(ADMIN, 9, { name: "Boss", permissions: "8" }), ADMIN)
    expect(await f.edit({ role: ADMIN, name: "Boss" })).toMatchObject({ changed: ["name"] })
  })

  test("reports a failed store under errors and still returns the role", async () => {
    f.serveEdit()
    f.seed((m) =>
      m.exec("CREATE TRIGGER no_role_changes BEFORE UPDATE ON roles BEGIN SELECT RAISE(ABORT, 'full'); END"),
    )
    expect(await f.edit({ name: "Tea" })).toMatchObject({
      role: { id: TIE_A },
      errors: { snapshot: expect.any(String) },
    })
  })

  test("asks the permission rules about the label and the role", async () => {
    expect(await writeTargets(discordRoleEdit, { server: SERVER, role: TIE_A, name: "Tea" }, f.ctx)).toEqual([
      `default/role/${TIE_A}`,
    ])
  })
})
