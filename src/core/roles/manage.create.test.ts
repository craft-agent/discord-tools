import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { ROLE_SNAPSHOT_MAX_AGE_MS } from "../discord/mirror-roles"
import { SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { ROLE_CREATED_NOTE } from "./manage"
import {
  createdRole,
  createManageFixture,
  KICK_MEMBERS,
  type ManageFixture,
  NEW_ROLE,
  SEND_MESSAGES,
} from "./manage.testing"
import { discordRoleCreate } from "./manage-tool"
import { ADMIN, HELPER } from "./roles.testing"

let f: ManageFixture

beforeEach(async () => {
  f = await createManageFixture()
})

afterEach(() => f.dispose())

const created = (roles = f.snapshot()!.roles) => roles.find((role) => role.id === NEW_ROLE)

describe("creating a role", () => {
  test("posts the name and an empty permission set once, from the server's page, and stores the role", async () => {
    f.serveCreate()
    const before = f.snapshot()!
    expect(await f.create()).toEqual({
      server: SERVER,
      role: { id: NEW_ROLE, name: "Tea", position: 1 },
      permissions: [],
      note: ROLE_CREATED_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "POST", path: `/guilds/${SERVER}/roles` })
    expect(JSON.parse(request!.body!)).toEqual({ name: "Tea", permissions: "0" })
    expect(headerOf(request!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
    expect(headerOf(request!, "x-audit-log-reason")).toBeUndefined()
    expect(created()).toEqual({ id: NEW_ROLE, name: "Tea", position: 1, permissions: 0n, managed: false })
    expect(f.snapshot()).toMatchObject({ readAt: before.readAt, ownRoles: before.ownRoles })
    expect(f.snapshot()!.roles).toHaveLength(before.roles.length + 1)
  })

  test("sends the permissions as one decimal text, the color as a number, the flags given, and the reason", async () => {
    f.serveCreate(createdRole({ permissions: String(SEND_MESSAGES | KICK_MEMBERS), color: 0x1abc9c, hoist: false }))
    const result = await f.create({
      name: "  Tea  ",
      permissions: ["send_messages", "kick_members"],
      color: "#1ABC9C",
      hoist: false,
      mentionable: true,
      reason: "tea: party",
    })
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({
      name: "  Tea  ",
      permissions: String(SEND_MESSAGES | KICK_MEMBERS),
      color: 0x1abc9c,
      hoist: false,
      mentionable: true,
    })
    expect(headerOf(f.writes()[0]!, "x-audit-log-reason")).toBe("tea%3A party")
    expect(result.permissions).toEqual(["kick_members", "send_messages"])
  })

  test("takes a permission bit above 2^53 exactly, as the answer holds it", async () => {
    f.serveCreate(createdRole({ permissions: String(1n << 47n) }))
    expect((await f.create()).permissions).toEqual(["bit47"])
    expect(created()!.permissions).toBe(1n << 47n)
  })

  test("asks the permission rules about the server", async () => {
    expect(await writeTargets(discordRoleCreate, { server: SERVER, name: "Tea" }, f.ctx)).toEqual([
      "default/server/" + SERVER,
    ])
  })

  test("reports a failed store under errors and still returns the role", async () => {
    f.serveCreate()
    f.seed((m) => m.exec("CREATE TRIGGER no_new_roles BEFORE INSERT ON roles BEGIN SELECT RAISE(ABORT, 'full'); END"))
    expect(await f.create()).toMatchObject({ role: { id: NEW_ROLE }, errors: { snapshot: expect.any(String) } })
  })

  test("an owner gives any permission but administrator, and so does an administrator", async () => {
    await f.dispose()
    for (const options of [{ owner: true, held: [] }, { held: [ADMIN] }]) {
      f = await createManageFixture(options)
      f.serveCreate()
      await f.create({ permissions: ["manage_guild", "ban_members"] })
      expect(f.writes()).toHaveLength(1)
      expect(await failure(f.create({ permissions: ["administrator"] }))).toMatchObject({ code: "forbidden" })
      expect(f.writes()).toHaveLength(1)
      await f.dispose()
    }
    f = await createManageFixture()
  })
})

describe("what is refused before any request", () => {
  test.each([
    ["a server the mirror does not know", { server: "1400000000000000999" }, "not_found"],
    ["administrator", { permissions: ["administrator"] }, "forbidden"],
    ["a permission the user lacks", { permissions: ["send_messages", "manage_messages"] }, "forbidden"],
    ["a name Discord has no permission of", { permissions: ["send_messages", "bit47"] }, "invalid_argument"],
    ["an empty name", { name: "" }, "invalid_argument"],
    ["a blank name", { name: " \n" }, "invalid_argument"],
    ["a name of 101 characters", { name: "x".repeat(101) }, "invalid_argument"],
    ["a color that is no #rrggbb", { color: "#fff" }, "invalid_argument"],
    ["the color none, which only an edit takes", { color: "none" }, "invalid_argument"],
    ["a permission twice", { permissions: ["connect", "connect"] }, "invalid_argument"],
    ["a name for the server", { server: "general" }, "invalid_argument"],
    ["a blank reason", { reason: " " }, "invalid_argument"],
    ["an unknown argument", { role: HELPER }, "invalid_argument"],
  ])("%s", async (_, args, code) => {
    expect(await failure(f.create(args))).toMatchObject({ code })
    expect(f.discord.api).toEqual([])
  })

  test("a user who may not manage roles", async () => {
    await f.dispose()
    f = await createManageFixture({ held: [HELPER] })
    expect(await failure(f.create())).toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Manage Roles"),
    })
    expect(f.discord.api).toEqual([])
  })

  test("a server whose roles were never read, and a snapshot older than 15 minutes, each saying to read them", async () => {
    f.advance(ROLE_SNAPSHOT_MAX_AGE_MS)
    f.serveCreate()
    await f.create()
    f.advance(1)
    expect(await failure(f.create())).toMatchObject({
      code: "stale",
      message: expect.stringContaining("Read them again"),
    })
    await f.dispose()
    f = await createManageFixture({ stored: false })
    expect(await failure(f.create())).toMatchObject({
      code: "not_found",
      message: expect.stringContaining("discord_role_read method list"),
    })
    expect(f.writes()).toHaveLength(0)
  })

  test("names every permission the user lacks only for the ones it lacks", async () => {
    const error = await failure(f.create({ permissions: ["send_messages", "manage_messages", "manage_guild"] }))
    expect(error.message).toContain("manage_guild, manage_messages")
    expect(error.message).not.toContain("send_messages")
  })
})
