import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { ALICE, BOB, SERVER, userObject } from "../discord/objects.testing"
import { WEB_ORIGIN } from "../discord/request-headers"
import type { ErrorCode } from "../errors"
import { membersSearchPath } from "./members"
import {
  CAROL,
  createPeopleFixture,
  DAVE,
  type PeopleFixture,
  requestsOf,
  seedServers,
  storedUsersOf,
} from "./people.testing"

const OTHER_SERVER = "1400000000000000101"
const ROLE = "1400000000000000501"
const PATH = membersSearchPath(SERVER)

let f: PeopleFixture
beforeEach(async () => {
  f = await createPeopleFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

/** A hit as Discord's member search wraps it. */
const hit = (user: unknown, extra: Record<string, unknown> = {}) => ({
  member: { user, nick: null, joined_at: "2025-01-02T03:04:05.000000+00:00", roles: [], ...extra },
  source_invite_code: null,
  join_source_type: 0,
  inviter_id: null,
})
const answer = (members: unknown[], extra: Record<string, unknown> = {}) => ({
  status: 200,
  json: { guild_id: SERVER, members, page_result_count: members.length, total_result_count: members.length, ...extra },
})
const serve = (members: unknown[], extra: Record<string, unknown> = {}) =>
  f.discord.route("POST", PATH, answer(members, extra))
const search = (args: Record<string, unknown> = {}) =>
  f.people({ method: "members", server: SERVER, query: "ali", ...args })

describe("the request", () => {
  test("is one POST of the search by username, with the default limit, sent as a read", async () => {
    serve([])
    await search()
    expect(requestsOf(f)).toEqual([`POST ${PATH}`])
    const request = f.discord.api[0]!
    expect(JSON.parse(request.body!)).toEqual({ limit: 25, or_query: { usernames: { or_query: ["ali"] } } })
    expect([...request.query.keys()]).toEqual([])
    expect(headerOf(request, "content-type")).toContain("application/json")
    expect(headerOf(request, "referer")).toBe(`${WEB_ORIGIN}/channels/${SERVER}`)
  })

  test("takes the limit, and the query as it is", async () => {
    serve([])
    await search({ limit: 100, query: "Ali  Baba" })
    expect(JSON.parse(f.discord.api[0]!.body!)).toEqual({
      limit: 100,
      or_query: { usernames: { or_query: ["Ali  Baba"] } },
    })
  })

  test("in a server the mirror does not know is not_found, and nothing is requested", async () => {
    const error = await failure(search({ server: OTHER_SERVER }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(OTHER_SERVER)
    expect(f.discord.api).toEqual([])
  })
})

describe("the result", () => {
  test("lists the members in Discord's order, with their nickname, join time and role ids", async () => {
    serve(
      [
        hit(userObject(CAROL, { username: "carol", global_name: "Carol C" }), { nick: "CC", roles: [ROLE, ROLE] }),
        hit(userObject(ALICE, { username: "alice" })),
        hit(userObject(BOB, { username: "bob", global_name: "Bobby" }), { joined_at: null }),
      ],
      { total_result_count: 40 },
    )
    const result = await search()
    expect(result).toMatchObject({ method: "members", count: 3, total: 40 })
    expect(result.members).toEqual([
      { id: CAROL, name: "CC", username: "carol", nick: "CC", joined: "2025-01-02T03:04:05.000Z", roles: [ROLE] },
      { id: ALICE, name: "alice", username: "alice", nick: null, joined: "2025-01-02T03:04:05.000Z", roles: [] },
      { id: BOB, name: "Bobby", username: "bob", nick: null, joined: null, roles: [] },
    ])
  })

  test("takes a member object that is not wrapped, and skips an entry without a member with a user", async () => {
    serve([
      hit(userObject(ALICE)).member,
      hit(userObject(BOB)),
      { member: { nick: "no user" } },
      { member: { user: { id: "x" } } },
      { user: { username: "no id" } },
      "junk",
      null,
    ])
    const result = await search()
    expect(result.members?.map((member) => member.id)).toEqual([ALICE, BOB])
    expect(result.count).toBe(2)
  })

  test("has a total of null when Discord does not count, and an empty list for no match", async () => {
    serve([], { total_result_count: undefined })
    expect(await search()).toMatchObject({ members: [], count: 0, total: null })
    serve([], { total_result_count: -1 })
    expect(await search()).toMatchObject({ total: null })
  })

  test("says it is Discord's search by name, that names are people's words and what was stored", async () => {
    serve([])
    const { note } = await search()
    expect(note).toContain("Discord's own search")
    expect(note).toContain("Nothing but user names was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })

  test("stores the members' user objects and nothing else", async () => {
    serve([hit(userObject(ALICE)), hit(userObject(DAVE)), { member: { user: { id: "x" } } }])
    await search()
    expect(storedUsersOf(f)).toEqual([ALICE, DAVE])
    expect(f.inspect((m) => m.prepare("SELECT COUNT(*) AS n FROM servers").get())).toEqual({ n: 1 })
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an array", { status: 200, json: [] }],
    ["null", { status: 200, json: null }],
    ["no members", { status: 200, json: { total_result_count: 1 } }],
    ["members that are an object", { status: 200, json: { members: {} } }],
    ["no JSON", { status: 200, text: "<html>" }],
  ])("%s is an upstream error, and stores nothing", async (_name, malformed) => {
    f.discord.route("POST", PATH, malformed)
    expect((await failure(search())).code).toBe("upstream_error")
    expect(storedUsersOf(f)).toEqual([])
  })

  test("403 is forbidden, saying it needs Manage Server and to take ids elsewhere, with Discord's own message", async () => {
    f.discord.route("POST", PATH, { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    const error = await failure(search())
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("needs the Manage Server permission in that server")
    expect(error.message).toContain("take user ids from messages, mentions or the friend list instead")
    expect(error.message).toContain("Missing Permissions")
    expect(error.details).toEqual({ discord_code: 50013 })
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d is %s, passed on as it is", async (status, code) => {
    f.discord.route("POST", PATH, { status, json: { code: 0, message: "refused" } })
    const error = await failure(search())
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("Manage Server")
  })
})

describe("a search index still being built", () => {
  const indexing = { status: 202, json: { code: 110000, message: "Index not yet available.", retry_after: 4 } }

  test("is waited out once, and then the search succeeds, as one read after the other", async () => {
    f.discord.route("POST", PATH, [indexing, answer([hit(userObject(ALICE))])])
    const result = await search()
    expect(result.members).toHaveLength(1)
    expect(requestsOf(f)).toEqual([`POST ${PATH}`, `POST ${PATH}`])
    expect(f.sleeps).toContain(4500)
    expect(f.discord.api[1]!.body).toBe(f.discord.api[0]!.body)
  })

  test("is rate_limited when it is still being built after the wait, storing nothing", async () => {
    f.discord.route("POST", PATH, indexing)
    const error = await failure(search())
    expect(error.code).toBe("rate_limited")
    expect(requestsOf(f)).toHaveLength(2)
    expect(storedUsersOf(f)).toEqual([])
  })
})
