import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { createMembershipFixture, memberPath, type MembershipFixture, membershipPath } from "./membership.testing"
import { discordThreadLeave } from "./membership-tool"
import { OLD_THREAD } from "./threads.testing"

let f: MembershipFixture

beforeEach(async () => {
  f = await createMembershipFixture()
})

afterEach(() => f.dispose())

const args = { thread: OLD_THREAD }
const reads = () => f.discord.api.filter((request) => request.method === "GET")
const writes = () => f.discord.api.filter((request) => request.method !== "GET")

describe.each([
  ["a join", "PUT", () => f.join(args)],
  ["a leave", "DELETE", () => f.leave(args)],
] as const)("%s whose outcome is unknown", (_, method, call) => {
  test.each([
    [
      "a server error",
      () => f.discord.route(method, membershipPath(OLD_THREAD), { status: 500, json: { message: "x" } }),
    ],
    ["a failure after the request left", () => f.discord.failNext({ dispatched: true, message: "timed out" })],
    [
      "an answer that is not JSON",
      () => f.discord.route(method, membershipPath(OLD_THREAD), { status: 200, text: "<html>" }),
    ],
  ])("%s is uncertain, never retried, and read back once", async (_, serve) => {
    serve()
    f.discord.route("GET", memberPath(OLD_THREAD), { status: 200, json: { id: OLD_THREAD } })
    const error = await failure(call())
    expect(error).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { read_back: { member: true } },
    })
    expect(writes()).toHaveLength(1)
    expect(reads().map((request) => request.path)).toEqual([memberPath(OLD_THREAD)])
  })

  test("a read-back that finds no member record says the user is not a member", async () => {
    f.discord.route(method, membershipPath(OLD_THREAD), { status: 502, json: {} })
    f.discord.route("GET", memberPath(OLD_THREAD), { status: 404, json: { code: 10065, message: "Unknown Member" } })
    expect(await failure(call())).toMatchObject({ code: "uncertain", details: { read_back: { member: false } } })
    expect(reads()).toHaveLength(1)
  })

  test.each([
    ["a failing read", { status: 500, json: {} }],
    ["a refusal", { status: 403, json: { code: 50001, message: "Missing Access" } }],
  ])("%s as the read-back is reported as failed", async (_, answer) => {
    f.discord.route(method, membershipPath(OLD_THREAD), { status: 502, json: {} })
    f.discord.route("GET", memberPath(OLD_THREAD), answer)
    expect(await failure(call())).toMatchObject({ code: "uncertain", details: { read_back: "failed" } })
    expect(reads()).toHaveLength(1)
    expect(writes()).toHaveLength(1)
  })
})

describe("a cancelled call", () => {
  test("is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("DELETE", membershipPath(OLD_THREAD), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordThreadLeave
      .execute(args, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(reads()).toHaveLength(0)
  })
})
