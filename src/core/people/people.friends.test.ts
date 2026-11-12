import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ingestChannels } from "../discord/ingest"
import { columnOf, rowsOf } from "../discord/mirror.testing"
import { ALICE, BOB, channelObject, DM, userObject } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { RELATIONSHIPS_PATH } from "./friends"
import { CAROL, createPeopleFixture, DAVE, type PeopleFixture, relationship } from "./people.testing"

const alice = userObject(ALICE, { username: "alice", global_name: "Alice Liddell" })
const bob = userObject(BOB, { username: "bobby" })
const carol = userObject(CAROL, { username: "carol" })
const dave = userObject(DAVE, { username: "dave" })

let f: PeopleFixture
beforeEach(async () => {
  f = await createPeopleFixture()
})
afterEach(async () => {
  await f.dispose()
})

const serve = (...entries: unknown[]) => f.discord.route("GET", RELATIONSHIPS_PATH, { status: 200, json: entries })
const friends = (args: Record<string, unknown> = {}) => f.people({ method: "friends", ...args })
const ids = (result: { friends?: { id: string }[] }) => result.friends?.map((friend) => friend.id)
const storedUsers = () => f.inspect((m) => columnOf(m, "SELECT CAST(id AS TEXT) FROM users ORDER BY id"))
const dmWith = (id: string, ...recipients: unknown[]) =>
  f.seed((m) =>
    ingestChannels(m, f.ingestContext(), [channelObject(id, { type: recipients.length > 1 ? 3 : 1, recipients })]),
  )

describe("the request", () => {
  test("is one GET of the relationship list, with nothing to page by", async () => {
    serve(relationship(alice))
    await friends()
    expect(f.discord.api.map((request) => `${request.method} ${request.path}`)).toEqual([`GET ${RELATIONSHIPS_PATH}`])
    expect([...f.discord.api[0]!.query.keys()]).toEqual([])
  })
})

describe("the relationships", () => {
  test("list friends only and count requests by direction, leaving out blocks and other types", async () => {
    serve(
      relationship(alice, 1),
      relationship(bob, 2),
      relationship(carol, 3),
      relationship(dave, 4),
      relationship(userObject("1400000000000000006"), 3),
      relationship(userObject("1400000000000000007"), 5),
      relationship(userObject("1400000000000000008"), 6),
    )
    const result = await friends()
    expect(ids(result)).toEqual([ALICE])
    expect(result).toMatchObject({ method: "friends", count: 1, total: 1, requests: { incoming: 2, outgoing: 1 } })
  })

  test("of an empty list are an empty result", async () => {
    serve()
    expect(await friends()).toMatchObject({ friends: [], count: 0, total: 0, requests: { incoming: 0, outgoing: 0 } })
  })

  test("repeating a friend list them once", async () => {
    serve(relationship(alice), relationship(alice, 1, { nickname: "again" }))
    const result = await friends()
    expect(result.friends).toHaveLength(1)
    expect(result.friends![0]!.nickname).toBeNull()
  })
})

describe("a friend", () => {
  test("has an id, a name, the username, the nickname the user gave and when the friendship began", async () => {
    serve(relationship(alice, 1, { nickname: "Ally" }), relationship(bob, 1, { since: "not a time" }))
    const [first, second] = (await friends()).friends!
    expect(first).toEqual({
      id: ALICE,
      name: "Alice Liddell",
      username: "alice",
      nickname: "Ally",
      since: "2025-03-04T05:06:07.000Z",
      dm: null,
    })
    expect(second).toMatchObject({ id: BOB, name: "bobby", username: "bobby", nickname: null, since: null })
  })

  test("without a user object is named by its id", async () => {
    serve({ id: CAROL, type: 1 })
    expect((await friends()).friends).toEqual([
      { id: CAROL, name: CAROL, username: null, nickname: null, since: null, dm: null },
    ])
  })

  test("has the DM the mirror holds with only that friend, and none otherwise", async () => {
    dmWith(DM, alice)
    dmWith("1400000000000000302", alice, bob)
    serve(relationship(alice), relationship(bob), relationship(carol))
    expect((await friends()).friends!.map(({ id, dm }) => [id, dm])).toEqual([
      [ALICE, DM],
      [BOB, null],
      [CAROL, null],
    ])
    expect(f.discord.api.map((request) => request.method)).toEqual(["GET"])
  })
})

describe("the list", () => {
  test("is ordered by name ignoring case, then by id", async () => {
    serve(
      relationship(userObject("1400000000000000012", { username: "zed" })),
      relationship(userObject("1400000000000000011", { username: "Bea" })),
      relationship(userObject("1400000000000000010", { username: "bea" })),
      relationship(userObject("1400000000000000009", { username: "Aaron", global_name: "zoe" })),
    )
    expect(ids(await friends())).toEqual([
      "1400000000000000010",
      "1400000000000000011",
      "1400000000000000012",
      "1400000000000000009",
    ])
  })

  test("is filtered by name, username or nickname ignoring case, and counted before and after", async () => {
    serve(relationship(alice, 1, { nickname: "Sis" }), relationship(bob), relationship(carol, 1, { nickname: "ALI" }))
    expect(ids(await friends({ query: "LIDDELL" }))).toEqual([ALICE])
    expect(ids(await friends({ query: "bobb" }))).toEqual([BOB])
    expect(ids(await friends({ query: "sis" }))).toEqual([ALICE])
    const result = await friends({ query: "ali" })
    expect(ids(result)).toEqual([ALICE, CAROL])
    expect(result).toMatchObject({ count: 2, total: 3 })
    expect(await friends({ query: "nobody" })).toMatchObject({ friends: [], count: 0, total: 3 })
  })
})

describe("what is stored", () => {
  test("is the friends' users alone, not the users of requests or blocks", async () => {
    serve(relationship(alice), relationship(bob, 2), relationship(carol, 3), relationship(dave, 4))
    await friends({ query: "nobody" })
    expect(storedUsers()).toEqual([ALICE])
    expect(f.inspect((m) => rowsOf(m, "SELECT username, global_name FROM users"))).toEqual([
      { username: "alice", global_name: "Alice Liddell" },
    ])
    expect(f.inspect((m) => columnOf(m, "SELECT id FROM channels"))).toEqual([])
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an object", { status: 200, json: {} }],
    ["null", { status: 200, json: null }],
    ["a list with a non-object", { status: 200, json: [relationship(alice), "junk"] }],
    ["a friend without an id", { status: 200, json: [relationship(alice), { type: 1, user: bob }] }],
    ["a friend with a bad id", { status: 200, json: [relationship(alice), { id: "bob", type: 1, user: bob }] }],
    ["no JSON", { status: 200, text: "<html>" }],
  ])("%s is an upstream error and stores nothing", async (_name, malformed) => {
    f.discord.route("GET", RELATIONSHIPS_PATH, malformed)
    expect((await failure(friends())).code).toBe("upstream_error")
    expect(storedUsers()).toEqual([])
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d is %s, and stores nothing", async (status, code) => {
    f.discord.route("GET", RELATIONSHIPS_PATH, { status, json: { code: 0, message: "refused" } })
    expect((await failure(friends())).code).toBe(code)
    expect(storedUsers()).toEqual([])
  })

  test("is said to be the user's own list, with no requester named, and the names data", async () => {
    serve(relationship(alice))
    const { note } = await friends()
    expect(note).toContain("own friend list")
    expect(note).toContain("without saying who")
    expect(note).toContain("no DM was opened")
    expect(note).toContain(UNTRUSTED_NOTE)
  })
})
