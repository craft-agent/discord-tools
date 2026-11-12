import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { ALICE, BOB, ME, SERVER } from "../discord/objects.testing"
import { memberPath } from "../people/member"
import { CAROL } from "../people/people.testing"
import { bulkRolePath, memberRolePath } from "./assign"
import { type AssignFixture, createAssignFixture, STRANGER } from "./assign.testing"
import { discordRoleUnassign } from "./assign-tool"
import { memberIdsPath } from "./members"
import { TIE_A } from "./roles.testing"

let f: AssignFixture

beforeEach(async () => {
  f = await createAssignFixture()
})

afterEach(() => f.dispose())

const put = memberRolePath(SERVER, ALICE, TIE_A)
const bulk = bulkRolePath(SERVER, TIE_A)
const member = (roles: string[]) => ({ status: 200, json: { roles, user: { id: ALICE } } })

/** The ways a write can end without a verdict: a server error, a failure after the request left, an answer that is no JSON. */
const unknownOutcomes = (method: string, path: string): [string, () => unknown][] => [
  ["a server error", () => f.discord.route(method, path, { status: 500, json: { message: "x" } })],
  ["a failure after the request left", () => f.discord.failNext({ dispatched: true, message: "timed out" })],
  ["an answer that is not JSON", () => f.discord.route(method, path, { status: 200, text: "<html>" })],
]

describe.each([
  ["giving", "PUT", () => f.assign()],
  ["taking", "DELETE", () => f.unassign()],
] as const)("%s a role to one user whose outcome is unknown", (_, method, call) => {
  test.each(unknownOutcomes(method, put))(
    "%s is uncertain, never retried, and the member read back once",
    async (_, serve) => {
      serve()
      f.discord.route("GET", memberPath(SERVER, ALICE), member([TIE_A]))
      const error = await failure(call())
      expect(error).toMatchObject({
        code: "uncertain",
        message: expect.stringContaining("not sent again"),
        details: { read_back: { has_role: true } },
      })
      expect(f.writes()).toHaveLength(1)
      expect(f.reads().map((request) => request.path)).toEqual([memberPath(SERVER, ALICE)])
      expect(headerOf(f.reads()[0]!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
    },
  )

  test("a member who lacks the role, or has left the server, is read back as not holding it", async () => {
    f.discord.route(method, put, { status: 502, json: {} })
    f.discord.route("GET", memberPath(SERVER, ALICE), member([]))
    expect(await failure(call())).toMatchObject({ details: { read_back: { has_role: false } } })
    f.discord.route("GET", memberPath(SERVER, ALICE), { status: 404, json: { code: 10007, message: "Unknown Member" } })
    expect(await failure(call())).toMatchObject({ details: { read_back: { has_role: false } } })
  })

  test.each([
    ["a failing read", { status: 500, json: {} }],
    ["a refusal", { status: 403, json: { code: 50001, message: "Missing Access" } }],
    ["an answer that is no member", { status: 200, json: [] }],
  ])("%s as the read-back is reported as failed", async (_, answer) => {
    f.discord.route(method, put, { status: 502, json: {} })
    f.discord.route("GET", memberPath(SERVER, ALICE), answer)
    expect(await failure(call())).toMatchObject({ code: "uncertain", details: { read_back: "failed" } })
    expect(f.reads()).toHaveLength(1)
    expect(f.writes()).toHaveLength(1)
  })

  test("a connection never made is a plain failure with no read-back", async () => {
    f.discord.failNext({ dispatched: false, message: "refused" })
    expect(await failure(call())).toMatchObject({ code: "upstream_error" })
    expect(f.reads()).toEqual([])
  })
})

describe("giving a role to several users whose outcome is unknown", () => {
  const users = [ALICE, BOB, CAROL]

  test.each(unknownOutcomes("PATCH", bulk))(
    "%s is uncertain, never retried, and the role's member ids read back once",
    async (_, serve) => {
      serve()
      f.discord.route("GET", memberIdsPath(SERVER, TIE_A), { status: 200, json: [CAROL, STRANGER, ALICE] })
      const error = await failure(f.assign({ users }))
      expect(error).toMatchObject({
        code: "uncertain",
        details: { read_back: { holders: [ALICE, CAROL], capped: false } },
      })
      expect(f.writes()).toHaveLength(1)
      expect(f.reads().map((request) => request.path)).toEqual([memberIdsPath(SERVER, TIE_A)])
    },
  )

  test("a list as long as Discord gives is capped, so a missing user is unknown", async () => {
    f.discord.route("PATCH", bulk, { status: 500, json: {} })
    const ids = Array.from({ length: 100 }, (_, i) => String(1_400_000_000_000_002_000n + BigInt(i)))
    f.discord.route("GET", memberIdsPath(SERVER, TIE_A), { status: 200, json: ids })
    expect(await failure(f.assign({ users }))).toMatchObject({
      details: { read_back: { holders: [], capped: true } },
    })
  })

  test.each([
    ["a failing read", { status: 500, json: {} }],
    ["an answer that is no list", { status: 200, json: {} }],
  ])("%s as the read-back is reported as failed", async (_, answer) => {
    f.discord.route("PATCH", bulk, { status: 500, json: {} })
    f.discord.route("GET", memberIdsPath(SERVER, TIE_A), answer)
    expect(await failure(f.assign({ users }))).toMatchObject({ details: { read_back: "failed" } })
    expect(f.reads()).toHaveLength(1)
  })
})

describe("a cancelled call", () => {
  test("is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("DELETE", put, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordRoleUnassign
      .execute({ server: SERVER, role: TIE_A, user: ALICE }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toEqual([])
  })
})

describe("the user's own roles", () => {
  test("an uncertain change that reaches them expires the snapshot too", async () => {
    f.discord.route("PUT", memberRolePath(SERVER, ME, TIE_A), { status: 500, json: {} })
    f.discord.route("GET", memberPath(SERVER, ME), member([]))
    await failure(f.assign({ users: [ME] }))
    expect(f.snapshot()).toMatchObject({ readAt: 0 })
  })

  test("an uncertain change to someone else leaves it", async () => {
    const before = f.snapshot()
    f.discord.route("PUT", put, { status: 500, json: {} })
    await failure(f.assign())
    expect(f.snapshot()).toEqual(before)
  })
})
