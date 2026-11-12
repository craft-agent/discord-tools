import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, wholeCallDescription } from "../describe"
import { ALICE, BOB, ME, SERVER } from "../discord/objects.testing"
import { CAROL, DAVE, seedUsers } from "../people/people.testing"
import { type AssignFixture, ASSIGN_ROLES, createAssignFixture, STRANGER } from "./assign.testing"
import { discordRoleAssign, discordRoleUnassign } from "./assign-tool"
import { HELPER, MOD, roleObject, TIE_A } from "./roles.testing"

let f: AssignFixture

beforeEach(async () => {
  f = await createAssignFixture({ held: [MOD, HELPER] })
})

afterEach(() => f.dispose())

const target = { server: SERVER, role: TIE_A }
const describeAssign = (extra: object = {}) =>
  callDescription(discordRoleAssign, { ...target, users: [ALICE], ...extra }, f.ctx)
const describeUnassign = (extra: object = {}) =>
  callDescription(discordRoleUnassign, { ...target, user: ALICE, ...extra }, f.ctx)

const PINS = { role_permissions: "0", role_position: "1", role_managed: "false" }
const labels = (description: Awaited<ReturnType<typeof describeAssign>>) => description!.facts.map((fact) => fact.label)

describe("giving a role", () => {
  test("names the role and the user, with the server and no text, and pins the role", async () => {
    const description = await describeAssign()
    expect(description).toEqual({
      headline: { text: "About to give {role} to {members}", values: { role: "role 810", members: "user02" } },
      facts: [
        { label: "Server", value: "Tea house" },
        { label: "Role", value: "role 810" },
        { label: "Members", value: "user02" },
      ],
      pins: PINS,
    })
    expect(description).not.toHaveProperty("text")
  })

  test("lists the strong permissions the role holds", async () => {
    const description = await describeAssign({ role: HELPER })
    expect(description!.facts).toContainEqual({ label: "Strong permissions", value: "manage_messages" })
    expect(labels(description)).toEqual(["Server", "Role", "Members", "Strong permissions"])
    expect(description!.pins).toEqual({ ...PINS, role_permissions: String(1n << 13n), role_position: "3" })
  })

  test("names up to three users in the headline and counts the rest, while the Members fact lists them all", async () => {
    seedUsers(f, DAVE)
    const names = ["user02", "user03", "user04", "user05", "user01"]
    const users = [ALICE, BOB, CAROL, DAVE, ME]
    const headline = async (count: number) =>
      (await describeAssign({ users: users.slice(0, count) }))!.headline!.values!.members
    expect(await headline(3)).toBe("user02, user03, user04")
    expect(await headline(4)).toBe("user02, user03, user04 and 1 other")
    expect(await headline(5)).toBe("user02, user03, user04 and 2 others")
    const all = await describeAssign({ users })
    expect(all!.facts).toContainEqual({ label: "Members", value: names.join(", ") })
  })

  test("shows the reason as the text, verbatim and whole", async () => {
    const reason = `first line\n\n  second   line ${"x".repeat(300)}`
    const description = await wholeCallDescription(discordRoleAssign, { ...target, users: [ALICE], reason }, f.ctx)
    expect(description!.text).toEqual({ label: "Reason", body: reason })
  })

  test("names a role without a name, and a user without one, by their ids", async () => {
    f.store([...ASSIGN_ROLES, roleObject("1400000000000000830", 1, { name: null })])
    f.seed((m) => m.exec(`UPDATE users SET username = NULL WHERE id = ${ALICE}`))
    const description = await describeAssign({ role: "1400000000000000830" })
    expect(description!.headline!.values).toEqual({ role: "1400000000000000830", members: ALICE })
  })
})

describe("taking a role away", () => {
  test("names the role and the user, and lists no strong permissions", async () => {
    const description = await describeUnassign({ role: HELPER, reason: "left" })
    expect(description).toMatchObject({
      headline: { text: "About to take {role} from {member}", values: { role: "Helper", member: "user02" } },
      text: { label: "Reason", body: "left" },
    })
    expect(labels(description)).toEqual(["Server", "Role", "Members"])
  })
})

describe.each([
  ["assign", describeAssign, { users: [STRANGER] }],
  ["unassign", describeUnassign, { user: STRANGER }],
] as const)("the %s description", (_, describeCall, strangerArgs) => {
  test("pins the role's permissions, position and managed flag, so a changed role is stale", async () => {
    const before = await describeCall()
    const changes = [{ permissions: "8" }, { position: 2 }, { managed: true }].map((extra) => [
      ...ASSIGN_ROLES.filter((role) => role.id !== TIE_A),
      { ...roleObject(TIE_A, 1), ...extra },
    ])
    for (const roles of changes) {
      f.store(roles)
      expect((await describeCall())!.pins).not.toEqual(before!.pins)
    }
    f.store()
    expect(await describeCall()).toEqual(before)
  })

  test("is the same for the same mirror, sends no request, and is drawn from an out-of-date snapshot", async () => {
    const first = await describeCall()
    f.advance(60 * 60 * 1000)
    expect(await describeCall()).toEqual(first)
    expect(f.discord.api).toEqual([])
  })

  test.each([
    ["a server the mirror lacks", { server: "1400000000000000999" }],
    ["a role the snapshot lacks", { role: "1400000000000000999" }],
    ["a user the mirror lacks", strangerArgs],
  ])("gives none for %s", async (_, extra) => {
    expect(await describeCall(extra)).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})

test("gives none when the roles were never read", async () => {
  await f.dispose()
  f = await createAssignFixture({ stored: false })
  expect(await describeAssign()).toBeUndefined()
  expect(await describeUnassign()).toBeUndefined()
})
