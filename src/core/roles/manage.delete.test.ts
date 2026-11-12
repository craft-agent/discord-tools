import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { ROLE_SNAPSHOT_MAX_AGE_MS } from "../discord/mirror-roles"
import { SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { HIGH, PEER } from "./assign.testing"
import { ROLE_DELETED_HELD_NOTE, ROLE_DELETED_NOTE } from "./manage"
import { createManageFixture, type ManageFixture } from "./manage.testing"
import { rolePath } from "./manage-plan"
import { discordRoleDelete } from "./manage-tool"
import { ADMIN, BOT, HELPER, MOD, TIE_A } from "./roles.testing"

let f: ManageFixture

beforeEach(async () => {
  f = await createManageFixture({ held: [MOD, HELPER] })
})

afterEach(() => f.dispose())

const stored = (id: string) => f.snapshot()!.roles.find((role) => role.id === id)

describe("deleting a role", () => {
  test("deletes it once, with no body and no reason, from the server's page, and removes it from the snapshot", async () => {
    f.serveDelete()
    const before = f.snapshot()!
    expect(await f.remove()).toEqual({
      server: SERVER,
      role: { id: TIE_A, name: "role 810" },
      note: ROLE_DELETED_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: rolePath(SERVER, TIE_A) })
    expect(request!.body ?? "").toBe("")
    expect(headerOf(request!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
    expect(headerOf(request!, "x-audit-log-reason")).toBeUndefined()
    expect(stored(TIE_A)).toBeUndefined()
    expect(f.snapshot()!.roles).toHaveLength(before.roles.length - 1)
    expect(f.snapshot()).toMatchObject({ readAt: before.readAt, ownRoles: before.ownRoles })
  })

  test("sends the reason as the audit log header", async () => {
    f.serveDelete()
    await f.remove({ reason: "unused: old" })
    expect(headerOf(f.writes()[0]!, "x-audit-log-reason")).toBe("unused%3A old")
  })

  test("expires the snapshot instead when the user held the role, and keeps the stored role", async () => {
    f.serveDelete(HELPER)
    const result = await f.remove({ role: HELPER })
    expect(result).toEqual({ server: SERVER, role: { id: HELPER, name: "Helper" }, note: ROLE_DELETED_HELD_NOTE })
    expect(f.snapshot()).toMatchObject({ readAt: 0 })
    expect(stored(HELPER)).toBeDefined()
  })

  test("takes any 2xx answer as done, and lets an owner delete a role above any of their own", async () => {
    await f.dispose()
    f = await createManageFixture({ owner: true, held: [] })
    f.discord.route("DELETE", rolePath(SERVER, ADMIN), { status: 200, json: {} })
    expect(await f.remove({ role: ADMIN })).toMatchObject({ role: { id: ADMIN, name: "Admin" } })
    expect(stored(ADMIN)).toBeUndefined()
  })

  test("reports a failed store under errors and still returns the role", async () => {
    f.serveDelete()
    f.seed((m) => m.exec("CREATE TRIGGER keep_roles BEFORE DELETE ON roles BEGIN SELECT RAISE(ABORT, 'kept'); END"))
    expect(await f.remove()).toMatchObject({ role: { id: TIE_A }, errors: { snapshot: expect.any(String) } })
  })

  test("asks the permission rules about the label and the role", async () => {
    expect(await writeTargets(discordRoleDelete, { server: SERVER, role: TIE_A }, f.ctx)).toEqual([
      `default/role/${TIE_A}`,
    ])
  })
})

describe("what a deletion refuses before any request", () => {
  test.each([
    ["a server the mirror does not know", { server: "1400000000000000999" }, "not_found"],
    ["a role the snapshot does not list", { role: "1400000000000000999" }, "not_found"],
    ["@everyone", { role: SERVER }, "invalid_argument"],
    ["a role an integration manages", { role: BOT }, "invalid_argument"],
    ["a role as high as the user's highest", { role: PEER }, "forbidden"],
    ["a role above the user's highest", { role: HIGH }, "forbidden"],
    ["the user's own highest role", { role: MOD }, "forbidden"],
    ["a name for the role", { role: "helper" }, "invalid_argument"],
    ["a blank reason", { reason: "\n" }, "invalid_argument"],
    ["an unknown argument", { name: "Tea" }, "invalid_argument"],
  ])("%s", async (_, args, code) => {
    expect(await failure(f.remove(args))).toMatchObject({ code })
    expect(f.discord.api).toEqual([])
  })

  test("a user who may not manage roles", async () => {
    await f.dispose()
    f = await createManageFixture({ held: [HELPER] })
    expect(await failure(f.remove())).toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Manage Roles"),
    })
    expect(f.discord.api).toEqual([])
  })

  test("a server whose roles were never read, and a snapshot older than 15 minutes", async () => {
    f.advance(ROLE_SNAPSHOT_MAX_AGE_MS + 1)
    expect(await failure(f.remove())).toMatchObject({ code: "stale" })
    await f.dispose()
    f = await createManageFixture({ stored: false })
    expect(await failure(f.remove())).toMatchObject({ code: "not_found" })
    expect(f.discord.api).toEqual([])
  })
})
