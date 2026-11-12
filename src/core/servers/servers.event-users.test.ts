import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { columnOf, rowsOf } from "../discord/mirror.testing"
import { ALICE, BOB, SERVER, userObject } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { CAROL, requestsOf, seedServers, storedUsersOf } from "../people/people.testing"
import { eventUsersPath } from "./event-users"
import { createServerFixture, type ServerFixture } from "./servers.testing"

const EVENT = "1400000000000000701"
const PATH = eventUsersPath(SERVER, EVENT)

const alice = userObject(ALICE, { username: "alice", global_name: "Alice Liddell" })
const bob = userObject(BOB, { username: "bobby" })
const carol = userObject(CAROL, { username: "carol" })

let f: ServerFixture
beforeEach(async () => {
  f = await createServerFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const entry = (user: unknown, extra: Record<string, unknown> = {}) => ({
  guild_scheduled_event_id: EVENT,
  user,
  ...extra,
})
const serve = (list: unknown) => f.discord.route("GET", PATH, { status: 200, json: list })
const read = (args: Record<string, unknown> = {}) =>
  f.servers({ method: "events", server: SERVER, event: EVENT, ...args })

describe("the request", () => {
  test("is one GET of the event's users with the default limit and the members, and no after", async () => {
    serve([entry(alice)])
    await read()
    expect(requestsOf(f)).toEqual([`GET ${PATH}`])
    expect(Object.fromEntries(f.discord.api[0]!.query)).toEqual({ limit: "100", with_member: "true" })
  })

  test("carries the limit and the after it is given", async () => {
    serve([])
    await read({ limit: 10, after: ALICE })
    expect(Object.fromEntries(f.discord.api[0]!.query)).toEqual({ limit: "10", after: ALICE, with_member: "true" })
  })
})

describe("the result", () => {
  test("names each user by nickname, else display name, else username, else id, in Discord's order", async () => {
    serve([
      entry(carol, { member: { nick: "Caz" } }),
      entry(alice, { member: { nick: null } }),
      entry(bob),
      entry({ id: "1400000000000000006" }),
    ])
    const result = await read()
    expect(result.interested_users).toEqual([
      { id: CAROL, name: "Caz", username: "carol", nick: "Caz" },
      { id: ALICE, name: "Alice Liddell", username: "alice", nick: null },
      { id: BOB, name: "bobby", username: "bobby", nick: null },
      { id: "1400000000000000006", name: "1400000000000000006", username: null, nick: null },
    ])
    expect(result).toMatchObject({ method: "events", event: EVENT, count: 4, next_after: null })
    expect(result.events).toBeUndefined()
  })

  test("takes the users from an object with `users` as well", async () => {
    serve({ users: [entry(alice)] })
    expect((await read()).interested_users?.map((user) => user.id)).toEqual([ALICE])
  })

  test("leaves out an entry without a user with a valid id", async () => {
    serve([{ guild_scheduled_event_id: EVENT }, entry({ id: "alice" }), entry("alice"), entry(bob)])
    expect((await read()).interested_users?.map((user) => user.id)).toEqual([BOB])
  })

  test("of nobody is empty", async () => {
    serve([])
    expect(await read()).toMatchObject({ interested_users: [], count: 0, next_after: null })
  })

  test("gives the last user as `next_after` when the page was full, else null", async () => {
    serve([entry(alice), entry(bob)])
    expect(await read({ limit: 2 })).toMatchObject({ count: 2, next_after: BOB })
    expect(await read({ limit: 3 })).toMatchObject({ count: 2, next_after: null })
  })

  test("says who is listed, how to page, that names are people's words and what was stored", async () => {
    serve([entry(alice)])
    const { note } = await read()
    expect(note).toContain("said they are interested")
    expect(note).toContain("`next_after`")
    expect(note).toContain("Only user names were stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })
})

describe("what is stored", () => {
  test("is the users alone", async () => {
    serve([entry(alice, { member: { nick: "Ally" } }), entry(bob)])
    await read()
    expect(storedUsersOf(f)).toEqual([ALICE, BOB])
    expect(f.inspect((m) => rowsOf(m, "SELECT username, global_name FROM users ORDER BY id"))).toEqual([
      { username: "alice", global_name: "Alice Liddell" },
      { username: "bobby", global_name: null },
    ])
    expect(f.inspect((m) => columnOf(m, "SELECT id FROM channels"))).toEqual([])
  })
})

describe("Discord's answer", () => {
  test("404 is not_found, keeping its code, and says there is no such event", async () => {
    f.discord.route("GET", PATH, { status: 404, json: { code: 10070, message: "Unknown Guild Scheduled Event" } })
    const error = await failure(read())
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("No such event in that server (finished events are not listed)")
    expect(storedUsersOf(f)).toEqual([])
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [500, "upstream_error"],
  ])("%d is %s, as it is", async (status, code) => {
    f.discord.route("GET", PATH, { status, json: { code: 0, message: "refused" } })
    const error = await failure(read())
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("No such event")
  })

  test.each([
    ["null", null],
    ["an object without users", {}],
    ["a list with a non-object", [entry(alice), "junk"]],
  ])("%s is an upstream error and stores nothing", async (_name, malformed) => {
    serve(malformed)
    expect((await failure(read())).code).toBe("upstream_error")
    expect(storedUsersOf(f)).toEqual([])
  })
})
