import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ROLE_SNAPSHOT_MAX_AGE_MS } from "../discord/mirror-roles"
import { SERVER } from "../discord/objects.testing"
import { ASSIGN_ROLES, HIGH, PEER, WEAK_ADMIN } from "./assign.testing"
import { createManageFixture, type ManageFixture } from "./manage.testing"
import { ADMIN, BOT, HELPER, MOD, roleObject, TIE_A } from "./roles.testing"

let f: ManageFixture

beforeEach(async () => {
  f = await createManageFixture()
})

afterEach(() => f.dispose())

describe("what an edit refuses before any request", () => {
  test.each([
    ["a server the mirror does not know", { server: "1400000000000000999", name: "Tea" }, "not_found"],
    ["a role the snapshot does not list", { role: "1400000000000000999", name: "Tea" }, "not_found"],
    ["a role as high as the user's highest", { role: PEER, name: "Tea" }, "forbidden"],
    ["a role above the user's highest", { role: HIGH, name: "Tea" }, "forbidden"],
    ["a role an integration manages", { role: BOT, name: "Tea" }, "invalid_argument"],
    ["a name and more for @everyone", { role: SERVER, name: "Tea", grant: ["kick_members"] }, "invalid_argument"],
    ["a color for @everyone", { role: SERVER, color: "#ffffff" }, "invalid_argument"],
    ["a hoist for @everyone", { role: SERVER, hoist: true }, "invalid_argument"],
    ["a mentionable for @everyone", { role: SERVER, mentionable: false }, "invalid_argument"],
    ["a permission in grant and in revoke", { grant: ["kick_members"], revoke: ["kick_members"] }, "invalid_argument"],
    ["granting administrator", { grant: ["administrator"] }, "forbidden"],
    ["granting a permission the user lacks", { grant: ["kick_members", "manage_messages"] }, "forbidden"],
    ["a name Discord has no permission of", { revoke: ["bit47"] }, "invalid_argument"],
    ["nothing at all", {}, "invalid_argument"],
    ["only a reason", { reason: "why" }, "invalid_argument"],
    ["a name that is the stored one", { name: "role 810" }, "invalid_argument"],
    ["a color none for a role without one", { color: "none" }, "invalid_argument"],
    ["a flag the role has", { hoist: false, mentionable: false }, "invalid_argument"],
    ["an empty grant", { name: "Tea", grant: [] }, "invalid_argument"],
    ["an empty revoke", { name: "Tea", revoke: [] }, "invalid_argument"],
    ["a revoke of what the role lacks", { revoke: ["kick_members"] }, "invalid_argument"],
    ["an empty name", { name: "" }, "invalid_argument"],
    ["a blank name", { name: " " }, "invalid_argument"],
    ["a name of 101 characters", { name: "x".repeat(101) }, "invalid_argument"],
    ["a color that is no #rrggbb", { color: "red" }, "invalid_argument"],
    ["a permission twice", { grant: ["connect", "connect"] }, "invalid_argument"],
    ["a name for the role", { role: "helper", name: "Tea" }, "invalid_argument"],
    ["an unknown argument", { name: "Tea", users: [] }, "invalid_argument"],
  ])("%s", async (_, args, code) => {
    expect(await failure(f.edit(args))).toMatchObject({ code })
    expect(f.discord.api).toEqual([])
  })

  test("granting a permission the user lacks names only what is lacking", async () => {
    const error = await failure(f.edit({ grant: ["kick_members", "manage_messages"] }))
    expect(error.message).toContain("manage_messages")
    expect(error.message).not.toContain("kick_members")
  })

  test("granting administrator, even to an owner", async () => {
    await f.dispose()
    f = await createManageFixture({ owner: true, held: [] })
    expect(await failure(f.edit({ role: WEAK_ADMIN, grant: ["administrator"] }))).toMatchObject({ code: "forbidden" })
    expect(f.discord.api).toEqual([])
  })

  test("a grant of what the role holds, with a revoke of what it lacks", async () => {
    f.store([...ASSIGN_ROLES.filter((role) => role.id !== TIE_A), roleObject(TIE_A, 1, { permissions: "2048" })])
    expect(await failure(f.edit({ grant: ["send_messages"], revoke: ["kick_members"] }))).toMatchObject({
      code: "invalid_argument",
    })
    expect(f.discord.api).toEqual([])
  })

  test("a role that already is as stored, naming it", async () => {
    f.store([...ASSIGN_ROLES.filter((role) => role.id !== TIE_A), roleObject(TIE_A, 1, { color: 0x1abc9c })])
    const error = await failure(f.edit({ color: "#1ABC9C", name: "role 810" }))
    expect(error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining(TIE_A) })
  })

  test("a user who may not manage roles", async () => {
    await f.dispose()
    f = await createManageFixture({ held: [HELPER] })
    expect(await failure(f.edit({ name: "Tea" }))).toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Manage Roles"),
    })
    expect(await failure(f.edit({ role: SERVER, revoke: ["send_messages"] }))).toMatchObject({ code: "forbidden" })
    expect(f.discord.api).toEqual([])
  })

  test("a server whose roles were never read, and a snapshot older than 15 minutes", async () => {
    f.advance(ROLE_SNAPSHOT_MAX_AGE_MS + 1)
    expect(await failure(f.edit({ name: "Tea" }))).toMatchObject({ code: "stale" })
    await f.dispose()
    f = await createManageFixture({ stored: false })
    expect(await failure(f.edit({ name: "Tea" }))).toMatchObject({ code: "not_found" })
    expect(f.discord.api).toEqual([])
  })

  test("an owner edits a role above their own, but not one an integration manages", async () => {
    await f.dispose()
    f = await createManageFixture({ owner: true, held: [MOD] })
    expect(await failure(f.edit({ role: BOT, name: "Tea" }))).toMatchObject({ code: "invalid_argument" })
    f.serveEdit(roleObject(ADMIN, 9, { name: "Tea", permissions: "8" }), ADMIN)
    await f.edit({ role: ADMIN, name: "Tea" })
    expect(f.writes()).toHaveLength(1)
  })
})
