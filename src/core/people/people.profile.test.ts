import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { FAKE_TOKEN } from "../discord/client.testing"
import { ALICE, BOB, SERVER, userObject } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import {
  CAROL,
  createPeopleFixture,
  DAVE,
  type PeopleFixture,
  requestsOf,
  seedServers,
  seedUsers,
  storedUsersOf,
} from "./people.testing"
import { profilePath } from "./profile"

const OTHER_SERVER = "1400000000000000101"

let f: PeopleFixture
beforeEach(async () => {
  f = await createPeopleFixture()
  seedUsers(f, ALICE)
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const serve = (body: unknown) => f.discord.route("GET", profilePath(ALICE), { status: 200, json: body })
const profile = (args: Record<string, unknown> = {}) => f.people({ method: "profile", user: ALICE, ...args })

describe("the request", () => {
  test("is one GET of the person's profile with their mutual servers and friends counted", async () => {
    serve({ user: userObject(ALICE) })
    await profile()
    expect(requestsOf(f)).toEqual([`GET ${profilePath(ALICE)}`])
    expect(Object.fromEntries(f.discord.api[0]!.query)).toEqual({
      with_mutual_guilds: "true",
      with_mutual_friends: "true",
      with_mutual_friends_count: "true",
    })
  })

  test("asks for the member profile of a server the mirror knows when `server` is given", async () => {
    serve({ user: userObject(ALICE) })
    await profile({ server: SERVER })
    expect(f.discord.api[0]!.query.get("guild_id")).toBe(SERVER)
  })

  test("of a user the mirror does not know is not_found, and nothing is requested", async () => {
    const error = await failure(profile({ user: BOB }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(BOB)
    expect(f.discord.api).toEqual([])
  })

  test("with a server the mirror does not know is not_found, and nothing is requested", async () => {
    const error = await failure(profile({ server: OTHER_SERVER }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(OTHER_SERVER)
    expect(f.discord.api).toEqual([])
  })
})

describe("the result", () => {
  const full = {
    user: userObject(ALICE, { username: "alice", global_name: "Alice L", bot: false, bio: "old bio" }),
    user_profile: { bio: "I like tea", pronouns: "she/her" },
    connected_accounts: [
      { type: "github", id: "9", name: "alice-gh", verified: true },
      { type: "steam", id: "8", name: "alice-steam" },
      { type: "", name: "no type" },
      { type: "twitch", name: "" },
      "junk",
    ],
    mutual_guilds: [{ id: SERVER, nick: "Al" }, { id: OTHER_SERVER, nick: null }, { id: "x" }, { nick: "no id" }],
    mutual_friends: [
      userObject(DAVE, { username: "dave" }),
      userObject(CAROL, { username: "carol", global_name: "Zed" }),
      userObject(BOB, { username: "bob" }),
      { username: "no id" },
    ],
    mutual_friends_count: 3,
    guild_member: { nick: "Al", joined_at: "2025-01-02T03:04:05.000000+00:00", roles: [CAROL, "x", CAROL, DAVE] },
  }

  test("maps the person, their bio and pronouns, connected accounts and mutual servers and friends", async () => {
    serve(full)
    const result = await profile()
    expect(result.profile).toEqual({
      id: ALICE,
      name: "Alice L",
      username: "alice",
      bot: false,
      bio: "I like tea",
      pronouns: "she/her",
      connected_accounts: [
        { type: "github", name: "alice-gh", verified: true },
        { type: "steam", name: "alice-steam", verified: false },
      ],
      mutual_servers: [
        { id: SERVER, name: "Tea house", nick: "Al" },
        { id: OTHER_SERVER, name: null, nick: null },
      ],
      mutual_friends: [
        { id: BOB, name: "bob", username: "bob" },
        { id: DAVE, name: "dave", username: "dave" },
        { id: CAROL, name: "Zed", username: "carol" },
      ],
      mutual_friends_count: 3,
      member: null,
    })
    expect(result.method).toBe("profile")
  })

  test("has the member only with `server` and a guild_member, with the role ids", async () => {
    serve(full)
    expect((await profile({ server: SERVER })).profile?.member).toEqual({
      server: SERVER,
      nick: "Al",
      joined: "2025-01-02T03:04:05.000Z",
      roles: [CAROL, DAVE],
    })
    serve({ ...full, guild_member: undefined })
    expect((await profile({ server: SERVER })).profile?.member).toBeNull()
  })

  test("falls back to the bio of the user, and leaves empty fields null", async () => {
    serve({ user: userObject(ALICE, { bio: "old bio" }), user_profile: { bio: "", pronouns: "" } })
    expect((await profile()).profile).toMatchObject({
      name: "user02",
      bio: "old bio",
      pronouns: null,
      connected_accounts: [],
      mutual_servers: [],
      mutual_friends: [],
      mutual_friends_count: null,
    })
    serve({ user: userObject(ALICE), user_profile: { bio: "" } })
    expect((await profile()).profile?.bio).toBeNull()
  })

  test("marks a bot, and works with only the user known from the mirror", async () => {
    serve({ user: userObject(ALICE, { bot: true }) })
    expect((await profile()).profile).toMatchObject({ bot: true, name: "user02" })
    serve({})
    expect((await profile()).profile).toMatchObject({ id: ALICE, username: "user02", bot: false, bio: null })
  })

  test("takes a negative or fractional friend count as not said", async () => {
    serve({ mutual_friends_count: -1 })
    expect((await profile()).profile?.mutual_friends_count).toBeNull()
    serve({ mutual_friends_count: 1.5 })
    expect((await profile()).profile?.mutual_friends_count).toBeNull()
  })

  test("says the words are the person's own, that roles are not resolved and that nothing but names was stored", async () => {
    serve({})
    const { note } = await profile()
    expect(note).toContain("own words")
    expect(note).toContain("method member")
    expect(note).toContain("Nothing but user names was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })
})

describe("the mirror", () => {
  test("gets the profile's user and the mutual friends' user objects, and nothing else", async () => {
    serve({
      user: userObject(ALICE, { username: "alice-new" }),
      mutual_friends: [userObject(BOB), userObject(CAROL), { id: "x" }],
      mutual_guilds: [{ id: OTHER_SERVER }],
    })
    await profile()
    expect(storedUsersOf(f)).toEqual([ALICE, BOB, CAROL])
    expect((await profile()).profile?.username).toBe("alice-new")
    expect(f.inspect((m) => m.prepare("SELECT COUNT(*) AS n FROM servers").get())).toEqual({ n: 1 })
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an array", { status: 200, json: [] }],
    ["null", { status: 200, json: null }],
    ["no JSON", { status: 200, text: "<html>" }],
  ])("%s is an upstream error", async (_name, malformed) => {
    f.discord.route("GET", profilePath(ALICE), malformed)
    expect((await failure(profile())).code).toBe("upstream_error")
    expect(storedUsersOf(f)).toEqual([ALICE])
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [404, "not_found"],
  ])("%d is %s, said with who sees a profile, and keeps Discord's own message and code", async (status, code) => {
    f.discord.route("GET", profilePath(ALICE), { status, json: { code: 50001, message: "Missing Access" } })
    const error = await failure(profile())
    expect(error.code).toBe(code)
    expect(error.message).toContain("only to a friend, someone who shares a server")
    expect(error.message).toContain("a bot or someone with a pending friend request")
    expect(error.message).toContain("Missing Access")
    expect(error.details).toEqual({ discord_code: 50001 })
    expect(error.message).not.toContain(FAKE_TOKEN)
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [429, "rate_limited"],
    [500, "upstream_error"],
  ])("%d is %s, passed on as it is", async (status, code) => {
    f.discord.route("GET", profilePath(ALICE), { status, json: { code: 0, message: "refused", retry_after: 100 } })
    const error = await failure(profile())
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("only to a friend")
  })
})
