import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { ALICE, BOB, ME, SERVER } from "../discord/objects.testing"
import { CAROL } from "../people/people.testing"
import { writeTargets } from "../targets"
import { bulkRolePath, memberRolePath, ROLE_GIVEN_NOTE, ROLE_TAKEN_NOTE } from "./assign"
import { discordRoleAssign, discordRoleUnassign } from "./assign-tool"
import { type AssignFixture, createAssignFixture } from "./assign.testing"
import { TIE_A } from "./roles.testing"

let f: AssignFixture

beforeEach(async () => {
  f = await createAssignFixture()
})

afterEach(() => f.dispose())

const put = (user = ALICE) => memberRolePath(SERVER, user, TIE_A)
const bulk = bulkRolePath(SERVER, TIE_A)
const named = (id: string) => ({ id, name: `user${id.slice(-2)}` })

describe("giving a role to one user", () => {
  test("puts it once, with no body and no reason, from the server's page, and names the role and the user", async () => {
    f.discord.route("PUT", put(), { status: 204 })
    expect(await f.assign()).toEqual({
      server: SERVER,
      role: { id: TIE_A, name: "role 810" },
      members: [named(ALICE)],
      given: true,
      note: ROLE_GIVEN_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PUT", path: put() })
    expect(request!.body ?? "").toBe("")
    expect([...request!.query.keys()]).toEqual([])
    expect(headerOf(request!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
    expect(headerOf(request!, "x-audit-log-reason")).toBeUndefined()
  })

  test("sends the reason as the audit log header, percent-encoded as the web client does", async () => {
    f.discord.route("PUT", put(), { status: 204 })
    await f.assign({ reason: "tidy up: é (old)" })
    expect(headerOf(f.writes()[0]!, "x-audit-log-reason")).toBe("tidy up%3A %C3%A9 %28old%29")
  })

  test("takes any 2xx answer as done", async () => {
    f.discord.route("PUT", put(), { status: 200, json: {} })
    expect(await f.assign()).toMatchObject({ given: true })
  })

  test("names a user the mirror holds no name for by null", async () => {
    f.seed((m) => m.exec(`UPDATE users SET username = NULL WHERE id = ${ALICE}`))
    f.discord.route("PUT", put(), { status: 204 })
    expect((await f.assign()).members).toEqual([{ id: ALICE, name: null }])
  })
})

describe("giving a role to several users", () => {
  const users = [ALICE, BOB, CAROL]

  test("patches the role's members once, with the ids in order, and the reason", async () => {
    f.discord.route("PATCH", bulk, { status: 200, json: {} })
    const result = await f.assign({ users, reason: "event staff" })
    expect(result.members).toEqual(users.map(named))
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PATCH", path: bulk })
    expect(JSON.parse(request!.body!)).toEqual({ member_ids: users })
    expect(headerOf(request!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
    expect(headerOf(request!, "x-audit-log-reason")).toBe("event staff")
  })

  test("says which ids Discord listed in its answer, and which it did not", async () => {
    f.discord.route("PATCH", bulk, { status: 200, json: { [ALICE]: { user: { id: ALICE } }, [CAROL]: {} } })
    expect(await f.assign({ users })).toMatchObject({ applied: [ALICE, CAROL], not_applied: [BOB] })
  })

  test("says an empty answer applied none", async () => {
    f.discord.route("PATCH", bulk, { status: 200, json: {} })
    expect(await f.assign({ users })).toMatchObject({ applied: [], not_applied: users })
  })

  test.each([
    ["a list", { status: 200, json: [] }],
    ["no content", { status: 204 }],
  ])("takes %s as everything asked, with neither list", async (_, answer) => {
    f.discord.route("PATCH", bulk, answer)
    const result = await f.assign({ users })
    expect(result).toMatchObject({ given: true, members: users.map(named) })
    expect(result).not.toHaveProperty("applied")
    expect(result).not.toHaveProperty("not_applied")
  })
})

describe("taking a role away", () => {
  test("deletes it once, with no body, and reports given false", async () => {
    f.discord.route("DELETE", put(), { status: 204 })
    expect(await f.unassign({ reason: "left the team" })).toEqual({
      server: SERVER,
      role: { id: TIE_A, name: "role 810" },
      members: [named(ALICE)],
      given: false,
      note: ROLE_TAKEN_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: put() })
    expect(request!.body ?? "").toBe("")
    expect(headerOf(request!, "x-audit-log-reason")).toBe("left the team")
    expect(headerOf(request!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
  })
})

describe("Discord's refusals", () => {
  test.each([
    [403, "forbidden", { code: 50013, message: "Missing Permissions" }],
    [404, "not_found", { code: 10007, message: "Unknown Member" }],
    [429, "rate_limited", { message: "slow down", retry_after: 1 }],
  ])("a %s passes through as %s, is sent once and read back by nothing", async (status, code, json) => {
    f.discord.route("PUT", put(), { status, json })
    f.discord.route("DELETE", put(), { status, json })
    for (const call of [() => f.assign(), () => f.unassign()]) {
      expect(await failure(call())).toMatchObject({ code })
    }
    expect(f.writes()).toHaveLength(2)
    expect(f.reads()).toEqual([])
  })
})

describe("the user's own roles", () => {
  test.each([
    ["giving", () => f.assign({ users: [ALICE, ME] }), "PATCH", bulk],
    ["taking", () => f.unassign({ user: ME }), "DELETE", put(ME)],
  ])(
    "%s one expires the snapshot, so the next role change must read the roles again",
    async (_, call, method, path) => {
      f.discord.route(method, path, {
        status: method === "PATCH" ? 200 : 204,
        json: method === "PATCH" ? {} : undefined,
      })
      expect(await call()).not.toHaveProperty("errors")
      expect(f.snapshot()).toMatchObject({ readAt: 0, roles: expect.any(Array) })
      expect(f.snapshot()!.roles.length).toBeGreaterThan(0)
      expect(await failure(f.assign())).toMatchObject({ code: "stale" })
      expect(f.writes()).toHaveLength(1)
    },
  )

  test("a change to other users leaves the snapshot as it was", async () => {
    const before = f.snapshot()
    f.discord.route("PUT", put(), { status: 204 })
    await f.assign()
    expect(f.snapshot()).toEqual(before)
  })

  test("a refused change leaves it too", async () => {
    const before = f.snapshot()
    f.discord.route("PUT", put(ME), { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    await failure(f.assign({ users: [ME] }))
    expect(f.snapshot()).toEqual(before)
  })
})

describe("the permission rules", () => {
  test("name the label and the role, for both tools", async () => {
    const rule = [`default/role/${TIE_A}`]
    expect(await writeTargets(discordRoleAssign, { server: SERVER, role: TIE_A, users: [ALICE] }, f.ctx)).toEqual(rule)
    expect(await writeTargets(discordRoleUnassign, { server: SERVER, role: TIE_A, user: ALICE }, f.ctx)).toEqual(rule)
  })
})
