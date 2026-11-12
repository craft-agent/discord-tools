import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, wholeCallDescription } from "../describe"
import { SERVER } from "../discord/objects.testing"
import { ASSIGN_ROLES } from "./assign.testing"
import { createManageFixture, type ManageFixture } from "./manage.testing"
import { discordRoleCreate, discordRoleDelete, discordRoleEdit } from "./manage-tool"
import { HELPER, MOD, roleObject, TIE_A } from "./roles.testing"

let f: ManageFixture

beforeEach(async () => {
  f = await createManageFixture({ held: [MOD, HELPER] })
})

afterEach(() => f.dispose())

const target = { server: SERVER, role: TIE_A }
const describeCreate = (extra: object = {}) =>
  callDescription(discordRoleCreate, { server: SERVER, name: "Tea", ...extra }, f.ctx)
const describeEdit = (extra: object = {}) => callDescription(discordRoleEdit, { ...target, ...extra }, f.ctx)
const describeDelete = (extra: object = {}) => callDescription(discordRoleDelete, { ...target, ...extra }, f.ctx)

const PINS = { role_permissions: "0", role_position: "1", role_managed: "false" }
const labels = (description: Awaited<ReturnType<typeof describeCreate>>) => description!.facts.map((fact) => fact.label)

describe("creating a role", () => {
  test("names the role by the name given, with the server, no permissions and no text, and pins nothing", async () => {
    const description = await describeCreate()
    expect(description).toEqual({
      headline: { text: "About to create the role {name}", values: { name: "Tea" } },
      facts: [
        { label: "Server", value: "Tea house" },
        { label: "New name", value: "Tea" },
        { label: "Permissions", value: { text: "None" } },
      ],
    })
  })

  test("lists the appearance given, every permission, and the strong ones among them", async () => {
    const description = await describeCreate({
      color: "#1ABC9C",
      hoist: true,
      mentionable: false,
      permissions: ["send_messages", "kick_members"],
    })
    expect(description!.facts).toEqual([
      { label: "Server", value: "Tea house" },
      { label: "New name", value: "Tea" },
      { label: "Strong permissions", value: "kick_members" },
      { label: "Color", value: "#1abc9c" },
      { label: "Listed apart", value: { text: "Yes" } },
      { label: "Mentionable", value: { text: "No" } },
      { label: "Permissions", value: "kick_members, send_messages" },
    ])
  })

  test("shows the name as given and the reason as the text, verbatim and whole", async () => {
    const reason = `first line\n\n  second   line ${"x".repeat(300)}`
    const description = await wholeCallDescription(discordRoleCreate, { server: SERVER, name: " Tea\n", reason }, f.ctx)
    expect(description!.headline!.values).toEqual({ name: " Tea\n" })
    expect(description!.text).toEqual({ label: "Reason", body: reason })
  })

  test("gives none for a server the mirror lacks and for roles never read", async () => {
    expect(await describeCreate({ server: "1400000000000000999" })).toBeUndefined()
    await f.dispose()
    f = await createManageFixture({ stored: false })
    expect(await describeCreate()).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})

describe("editing a role", () => {
  test("names the role, the server and only what is given", async () => {
    expect(await describeEdit({ name: "Tea" })).toEqual({
      headline: { text: "About to edit {role}", values: { role: "role 810" } },
      facts: [
        { label: "Server", value: "Tea house" },
        { label: "Role", value: "role 810" },
        { label: "New name", value: "Tea" },
      ],
      pins: PINS,
    })
  })

  test("lists the appearance, the permissions granted and revoked, and the strong ones granted", async () => {
    const description = await wholeCallDescription(
      discordRoleEdit,
      {
        ...target,
        name: "Tea",
        color: "none",
        hoist: true,
        mentionable: false,
        grant: ["send_messages", "kick_members"],
        revoke: ["manage_messages", "connect"],
        reason: "tea time",
      },
      f.ctx,
    )
    expect(description!.facts).toEqual([
      { label: "Server", value: "Tea house" },
      { label: "Role", value: "role 810" },
      { label: "New name", value: "Tea" },
      { label: "Strong permissions", value: "kick_members" },
      { label: "Color", value: { text: "None" } },
      { label: "Listed apart", value: { text: "Yes" } },
      { label: "Mentionable", value: { text: "No" } },
      { label: "Grant", value: "kick_members, send_messages" },
      { label: "Revoke", value: "manage_messages, connect" },
    ])
    expect(description!.text).toEqual({ label: "Reason", body: "tea time" })
  })

  test("lists no strong permissions for a revoke alone", async () => {
    expect(labels(await describeEdit({ revoke: ["manage_messages"] }))).toEqual(["Server", "Role", "Revoke"])
  })

  test("gives none for a permission in grant and revoke, and for a name Discord has no permission of", async () => {
    expect(await describeEdit({ grant: ["connect"], revoke: ["connect"] })).toBeUndefined()
    expect(await describeEdit({ grant: ["bit47"] })).toBeUndefined()
  })
})

describe("deleting a role", () => {
  test("names the server and the role, with the reason as the text", async () => {
    expect(await describeDelete({ role: HELPER, reason: "unused" })).toEqual({
      headline: { text: "About to delete {role}", values: { role: "Helper" } },
      facts: [
        { label: "Server", value: "Tea house" },
        { label: "Role", value: "Helper" },
      ],
      text: { label: "Reason", body: "unused" },
      pins: { ...PINS, role_permissions: String(1n << 13n), role_position: "3" },
    })
  })
})

describe.each([
  ["edit", describeEdit, { name: "Tea" }],
  ["delete", describeDelete, {}],
] as const)("the %s description", (_, describeCall, args) => {
  test("names a role without a name by its id", async () => {
    f.store([...ASSIGN_ROLES, roleObject("1400000000000000830", 1, { name: null })])
    const description = await describeCall({ ...args, role: "1400000000000000830" })
    expect(description!.headline!.values).toEqual({ role: "1400000000000000830" })
  })

  test("pins the role's permissions, position and managed flag, so a changed role is stale", async () => {
    const before = await describeCall(args)
    const changes = [{ permissions: "8" }, { position: 2 }, { managed: true }].map((extra) => [
      ...ASSIGN_ROLES.filter((role) => role.id !== TIE_A),
      { ...roleObject(TIE_A, 1), ...extra },
    ])
    for (const roles of changes) {
      f.store(roles)
      expect((await describeCall(args))!.pins).not.toEqual(before!.pins)
    }
    f.store()
    expect(await describeCall(args)).toEqual(before)
  })

  test("is the same for the same mirror, sends no request, and is drawn from an out-of-date snapshot", async () => {
    const first = await describeCall(args)
    f.advance(60 * 60 * 1000)
    expect(await describeCall(args)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })

  test.each([
    ["a server the mirror lacks", { server: "1400000000000000999" }],
    ["a role the snapshot lacks", { role: "1400000000000000999" }],
  ])("gives none for %s", async (_, extra) => {
    expect(await describeCall({ ...args, ...extra })).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})
