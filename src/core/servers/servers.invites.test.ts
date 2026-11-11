import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ALICE, BOB, CHANNEL, SERVER, userObject } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { requestsOf, seedServers, storedUsersOf } from "../people/people.testing"
import { invitesPath } from "./invites"
import { createServerFixture, type ServerFixture } from "./servers.testing"

const alice = userObject(ALICE, { username: "alice", global_name: "Alice Liddell" })
const bob = userObject(BOB, { username: "bobby" })

let f: ServerFixture
beforeEach(async () => {
  f = await createServerFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const invite = (code: string, extra: Record<string, unknown> = {}) => ({
  type: 0,
  code,
  channel: { id: CHANNEL, name: "general", type: 0 },
  inviter: alice,
  uses: 3,
  max_uses: 10,
  max_age: 86400,
  temporary: false,
  created_at: "2026-11-01T12:00:00.000000+00:00",
  expires_at: "2026-11-02T12:00:00.000000+00:00",
  ...extra,
})

const serve = (list: unknown) => f.discord.route("GET", invitesPath(SERVER), { status: 200, json: list })
const read = (args: Record<string, unknown> = {}) => f.servers({ method: "invites", server: SERVER, ...args })
const codes = (result: { invites?: { code: string }[] }) => result.invites?.map((item) => item.code)

describe("the request", () => {
  test("is one GET of the invites, with no query", async () => {
    serve([invite("abcdef")])
    await read()
    expect(requestsOf(f)).toEqual([`GET ${invitesPath(SERVER)}`])
    expect([...f.discord.api[0]!.query.keys()]).toEqual([])
  })
})

describe("an invite", () => {
  test("has its code and link, where it leads, who made it, its limits and its times", async () => {
    serve([invite("abcdef", { temporary: true })])
    expect((await read()).invites).toEqual([
      {
        code: "abcdef",
        url: "https://discord.gg/abcdef",
        channel: CHANNEL,
        channel_name: "general",
        inviter: ALICE,
        inviter_name: "Alice Liddell",
        uses: 3,
        max_uses: 10,
        max_age_s: 86400,
        expires: "2026-11-02T12:00:00.000Z",
        created: "2026-11-01T12:00:00.000Z",
        temporary: true,
      },
    ])
  })

  test("with no limits has null for unlimited uses and for never expiring", async () => {
    serve([invite("abcdef", { max_uses: 0, max_age: 0, expires_at: null })])
    expect((await read()).invites?.[0]).toMatchObject({ max_uses: null, max_age_s: null, expires: null })
  })

  test("without an expiry time of its own expires when its age runs out", async () => {
    serve([invite("abcdef", { expires_at: null, max_age: 3600 })])
    expect((await read()).invites?.[0]).toMatchObject({ max_age_s: 3600, expires: "2026-11-01T13:00:00.000Z" })
  })

  test("without a creation time has no computed expiry", async () => {
    serve([invite("abcdef", { expires_at: null, created_at: null })])
    expect((await read()).invites?.[0]).toMatchObject({ created: null, expires: null })
  })

  test("without what Discord may leave out has null, no uses and is not temporary", async () => {
    serve([{ code: "abcdef" }])
    expect((await read()).invites?.[0]).toEqual({
      code: "abcdef",
      url: "https://discord.gg/abcdef",
      channel: null,
      channel_name: null,
      inviter: null,
      inviter_name: null,
      uses: 0,
      max_uses: null,
      max_age_s: null,
      expires: null,
      created: null,
      temporary: false,
    })
  })

  test("takes its channel from `channel_id` when it has no channel object, and the inviter's username when it has no display name", async () => {
    serve([invite("abcdef", { channel: undefined, channel_id: CHANNEL, inviter: bob })])
    expect((await read()).invites?.[0]).toMatchObject({
      channel: CHANNEL,
      channel_name: null,
      inviter: BOB,
      inviter_name: "bobby",
    })
  })
})

describe("the list", () => {
  test("is ordered newest first, those without a time last, then by code", async () => {
    serve([
      invite("bbbb", { created_at: "2026-11-01T12:00:00.000000+00:00" }),
      invite("zzzz", { created_at: null }),
      invite("cccc", { created_at: "2026-11-05T12:00:00.000000+00:00" }),
      invite("aaaa", { created_at: "2026-11-01T12:00:00.000000+00:00" }),
      invite("yyyy", { created_at: null }),
    ])
    const result = await read()
    expect(codes(result)).toEqual(["cccc", "aaaa", "bbbb", "yyyy", "zzzz"])
    expect(result).toMatchObject({ count: 5, total: 5, list_truncated: false })
  })

  test("lists 25 when no limit is given, and says when it cut", async () => {
    serve(Array.from({ length: 26 }, (_, n) => invite(`code-${String(n).padStart(2, "0")}`)))
    const result = await read()
    expect(result.invites).toHaveLength(25)
    expect(result).toMatchObject({ count: 25, total: 26, list_truncated: true })
  })

  test("is cut at the limit, counting all of them", async () => {
    serve([invite("aaaa"), invite("bbbb"), invite("cccc")])
    const result = await read({ limit: 2 })
    expect(codes(result)).toEqual(["aaaa", "bbbb"])
    expect(result).toMatchObject({ count: 2, total: 3, list_truncated: true })
    expect(await read({ limit: 3 })).toMatchObject({ count: 3, total: 3, list_truncated: false })
  })

  test("of no invites is empty", async () => {
    serve([])
    expect(await read()).toMatchObject({ invites: [], count: 0, total: 0, list_truncated: false })
  })

  test("leaves out an entry without a code that looks like one", async () => {
    serve([
      { uses: 1 },
      invite(""),
      invite("a"),
      invite("has space"),
      invite("x".repeat(33)),
      { code: 7 },
      invite("ok-code"),
    ])
    expect(codes(await read())).toEqual(["ok-code"])
  })
})

describe("the note", () => {
  test("starts with the warning that a code goes to the user only", async () => {
    serve([invite("abcdef")])
    const { note } = await read()
    expect(
      note.startsWith("An invite code lets anyone who holds it join the server. Tell the codes to the user only"),
    ).toBe(true)
    expect(note).toContain("never put one into a message, a file or another tool unless the user asks for that")
    expect(note).toContain("Only the inviters' user names were stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })
})

describe("what is stored", () => {
  test("is the inviters' users alone, once each", async () => {
    serve([invite("aaaa"), invite("bbbb", { inviter: bob }), invite("cccc", { inviter: undefined })])
    await read()
    expect(storedUsersOf(f)).toEqual([ALICE, BOB])
  })
})

describe("Discord's answer", () => {
  test("403 is forbidden, keeping its code, and says it needs Manage Server", async () => {
    f.discord.route("GET", invitesPath(SERVER), { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    const error = await failure(read())
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("Listing a server's invites needs the Manage Server permission there.")
  })

  test.each<[number, ErrorCode]>([
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d is %s, as it is", async (status, code) => {
    f.discord.route("GET", invitesPath(SERVER), { status, json: { code: 0, message: "refused" } })
    const error = await failure(read())
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("Manage Server")
  })

  test.each([
    ["an object", {}],
    ["null", null],
    ["a list with a non-object", [invite("abcdef"), "junk"]],
  ])("%s is an upstream error and stores nothing", async (_name, malformed) => {
    serve(malformed)
    expect((await failure(read())).code).toBe("upstream_error")
    expect(storedUsersOf(f)).toEqual([])
  })
})
