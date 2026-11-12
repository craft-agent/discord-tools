import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { SERVER } from "../discord/objects.testing"
import { rolesPath } from "../people/role-list"
import { ASSIGN_ROLES } from "./assign.testing"
import { createManageFixture, type ManageFixture, NEW_ROLE } from "./manage.testing"
import { rolePath } from "./manage-plan"
import { discordRoleDelete } from "./manage-tool"
import { HELPER, MOD, roleObject, TIE_A } from "./roles.testing"

let f: ManageFixture

beforeEach(async () => {
  f = await createManageFixture({ held: [MOD, HELPER] })
})

afterEach(() => f.dispose())

const list = (...roles: unknown[]) => ({ status: 200, json: roles })
const serveList = (...roles: unknown[]) => f.discord.route("GET", rolesPath(SERVER), list(...roles))

/** The ways a write can end without a verdict: a server error, a failure after the request left, an answer that is no role. */
const unknownOutcomes = (method: string, path: string): [string, () => unknown][] => [
  ["a server error", () => f.discord.route(method, path, { status: 500, json: { message: "x" } })],
  ["a failure after the request left", () => f.discord.failNext({ dispatched: true, message: "timed out" })],
  ["an answer that is not JSON", () => f.discord.route(method, path, { status: 200, text: "<html>" })],
]

describe("a creation whose outcome is unknown", () => {
  const post = rolesPath(SERVER)

  test.each([
    ...unknownOutcomes("POST", post),
    ["an answer that is no role", () => f.discord.route("POST", post, { status: 200, json: { message: "x" } })],
  ])(
    "%s is uncertain, never retried, with the roles of that name as candidates, and nothing stored",
    async (_, serve) => {
      serve()
      serveList(
        roleObject(NEW_ROLE, 1, { name: "Tea" }),
        roleObject(TIE_A, 1, { name: "Other" }),
        roleObject(HELPER, 3, { name: "tea" }),
      )
      const before = f.snapshot()
      const error = await failure(f.create())
      expect(error).toMatchObject({
        code: "uncertain",
        message: expect.stringContaining("candidates"),
        details: { read_back: { candidates: [{ id: NEW_ROLE, name: "Tea", position: 1 }] } },
      })
      expect(f.writes()).toHaveLength(1)
      expect(f.reads().map((request) => request.path)).toEqual([post])
      expect(headerOf(f.reads()[0]!, "referer")).toBe(`https://discord.com/channels/${SERVER}`)
      expect(f.snapshot()).toEqual(before)
    },
  )

  test("a look that finds no role of that name lists no candidates", async () => {
    f.discord.route("POST", post, { status: 502, json: {} })
    serveList(roleObject(TIE_A, 1))
    expect(await failure(f.create())).toMatchObject({ details: { read_back: { candidates: [] } } })
  })

  test.each([
    ["a failing read", { status: 500, json: {} }],
    ["a refusal", { status: 403, json: { code: 50001, message: "Missing Access" } }],
    ["an answer that is no list", { status: 200, json: {} }],
  ])("%s as the read-back is reported as failed", async (_, answer) => {
    f.discord.route("POST", post, { status: 502, json: {} })
    f.discord.route("GET", post, answer)
    expect(await failure(f.create())).toMatchObject({ code: "uncertain", details: { read_back: "failed" } })
    expect(f.reads()).toHaveLength(1)
    expect(f.writes()).toHaveLength(1)
  })

  test("a refusal and a connection never made are plain failures with no read-back", async () => {
    f.discord.route("POST", post, { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    expect(await failure(f.create())).toMatchObject({ code: "forbidden" })
    f.discord.failNext({ dispatched: false, message: "refused" })
    expect(await failure(f.create())).toMatchObject({ code: "upstream_error" })
    expect(f.reads()).toEqual([])
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("POST", post, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await f.create({}, { ...f.ctx, signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toEqual([])
  })
})

describe("an edit whose outcome is unknown", () => {
  const patch = rolePath(SERVER, TIE_A)
  const others = ASSIGN_ROLES.filter((role) => role.id !== TIE_A)

  test.each(unknownOutcomes("PATCH", patch))(
    "%s is uncertain, never retried, and the roles read back once",
    async (_, serve) => {
      serve()
      serveList(...others, roleObject(TIE_A, 1, { name: "Tea" }))
      expect(await failure(f.edit({ name: "Tea", hoist: true }))).toMatchObject({
        code: "uncertain",
        details: { read_back: { present: true, as_asked: false } },
      })
      expect(f.writes()).toHaveLength(1)
      expect(f.reads().map((request) => request.path)).toEqual([rolesPath(SERVER)])
    },
  )

  test("a role that has every changed field is read back as asked, one that lacks them or is gone is not", async () => {
    f.discord.route("PATCH", patch, { status: 502, json: {} })
    serveList(...others, roleObject(TIE_A, 1, { name: "Tea", color: 5, permissions: "2" }))
    expect(await failure(f.edit({ name: "Tea", color: "#000005", grant: ["kick_members"] }))).toMatchObject({
      details: { read_back: { present: true, as_asked: true } },
    })
    serveList(...others, roleObject(TIE_A, 1, { name: "Tea", color: 5, permissions: "0" }))
    expect(await failure(f.edit({ name: "Tea", color: "#000005", grant: ["kick_members"] }))).toMatchObject({
      details: { read_back: { present: true, as_asked: false } },
    })
    serveList(...others)
    expect(await failure(f.edit({ name: "Tea" }))).toMatchObject({
      details: { read_back: { present: false, as_asked: false } },
    })
    expect(f.writes()).toHaveLength(3)
  })

  test("an answer that is another role is uncertain too, and a failing read is reported as failed", async () => {
    f.discord.route("PATCH", patch, { status: 200, json: roleObject(HELPER, 3) })
    f.discord.route("GET", rolesPath(SERVER), { status: 500, json: {} })
    expect(await failure(f.edit({ name: "Tea" }))).toMatchObject({
      code: "uncertain",
      details: { read_back: "failed" },
    })
    expect(f.snapshot()!.roles.find((role) => role.id === TIE_A)).toMatchObject({ name: "role 810" })
  })

  test("leaves the snapshot alone, but expires it when the user holds the role", async () => {
    const before = f.snapshot()
    f.discord.route("PATCH", patch, { status: 500, json: {} })
    serveList(...others)
    await failure(f.edit({ name: "Tea" }))
    expect(f.snapshot()).toEqual(before)
    f.discord.route("PATCH", rolePath(SERVER, HELPER), { status: 500, json: {} })
    await failure(f.edit({ role: HELPER, name: "Tea" }))
    expect(f.snapshot()).toMatchObject({ readAt: 0 })
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("PATCH", patch, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await f.edit({ name: "Tea" }, { ...f.ctx, signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toEqual([])
  })
})

describe("a deletion whose outcome is unknown", () => {
  const remove = rolePath(SERVER, TIE_A)

  test.each(unknownOutcomes("DELETE", remove))(
    "%s is uncertain, never retried, and the roles read back once",
    async (_, serve) => {
      serve()
      serveList(...ASSIGN_ROLES)
      expect(await failure(f.remove())).toMatchObject({ code: "uncertain", details: { read_back: { present: true } } })
      expect(f.writes()).toHaveLength(1)
      expect(f.reads().map((request) => request.path)).toEqual([rolesPath(SERVER)])
    },
  )

  test("a role the list no longer holds is read back as gone, and a failing read as failed", async () => {
    f.discord.route("DELETE", remove, { status: 502, json: {} })
    serveList(...ASSIGN_ROLES.filter((role) => role.id !== TIE_A))
    expect(await failure(f.remove())).toMatchObject({ details: { read_back: { present: false } } })
    f.discord.route("GET", rolesPath(SERVER), { status: 500, json: {} })
    expect(await failure(f.remove())).toMatchObject({ details: { read_back: "failed" } })
  })

  test("leaves the snapshot alone, but expires it when the user held the role", async () => {
    const before = f.snapshot()
    f.discord.route("DELETE", remove, { status: 500, json: {} })
    serveList(...ASSIGN_ROLES)
    await failure(f.remove())
    expect(f.snapshot()).toEqual(before)
    f.discord.route("DELETE", rolePath(SERVER, HELPER), { status: 500, json: {} })
    await failure(f.remove({ role: HELPER }))
    expect(f.snapshot()).toMatchObject({ readAt: 0 })
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("DELETE", remove, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordRoleDelete
      .execute({ server: SERVER, role: TIE_A }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toEqual([])
  })
})
