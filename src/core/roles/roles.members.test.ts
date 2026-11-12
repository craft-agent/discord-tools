import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { readRoleSnapshot } from "../discord/mirror-roles"
import { ALICE, BOB, SERVER } from "../discord/objects.testing"
import { requestsOf, seedUsers, storedUsersOf } from "../people/people.testing"
import { memberIdsPath } from "./members"
import { createRoleFixture, MOD, type RoleFixture, serveRoles } from "./roles.testing"

let f: RoleFixture
/** How many requests the fixture had made when the call under test began. */
let seen: number
beforeEach(async () => {
  f = await createRoleFixture()
  seen = 0
})
afterEach(async () => {
  await f.dispose()
})

const members = (role: string = MOD) => f.roles({ method: "members", server: SERVER, role })
const stored = () => f.inspect((m) => readRoleSnapshot(m, SERVER))
const requestsMade = () => requestsOf(f).slice(seen)

/** Reads the roles first, so the mirror holds the snapshot `members` needs, then makes the role's member ids what Discord answers. */
async function snapshotThen(ids: unknown) {
  serveRoles(f)
  await f.roles({ method: "list", server: SERVER })
  seen = f.discord.api.length
  f.discord.route("GET", memberIdsPath(SERVER, MOD), { status: 200, json: ids })
}

describe("method members", () => {
  test("is not_found before any request when no snapshot is stored, saying to call list", async () => {
    const error = await failure(members())
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("method list")
    expect(requestsMade()).toEqual([])
  })

  test("is not_found before any request for a role the snapshot lacks", async () => {
    await snapshotThen([])
    const error = await failure(members("1400000000000000999"))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("method list")
    expect(requestsMade()).toEqual([])
  })

  test("is not_found for a server the mirror does not know", async () => {
    const error = await failure(f.roles({ method: "members", server: "1400000000000000999", role: MOD }))
    expect(error.code).toBe("not_found")
    expect(requestsMade()).toEqual([])
  })

  test("refuses @everyone, the role whose id is the server's", async () => {
    await snapshotThen([])
    const error = await failure(members(SERVER))
    expect(error.code).toBe("invalid_argument")
    expect(requestsMade()).toEqual([])
  })

  test("asks for the role's member ids and names them from the mirror's users", async () => {
    await snapshotThen([ALICE, BOB, "1400000000000000777"])
    seedUsers(f, ALICE)
    const result = await members()
    expect(requestsMade()).toEqual([`GET ${memberIdsPath(SERVER, MOD)}`])
    expect(memberIdsPath(SERVER, MOD)).toBe(`/guilds/${SERVER}/roles/${MOD}/member-ids`)
    expect(result).toMatchObject({
      server: SERVER,
      role: { id: MOD, name: "Moderator" },
      members: [
        { id: ALICE, name: "user02" },
        { id: BOB, name: null },
        { id: "1400000000000000777", name: null },
      ],
      count: 3,
      capped: false,
    })
    expect(result.note).toContain(UNTRUSTED_NOTE)
  })

  test("says it reached Discord's cap of 100 ids, and not at 99", async () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, n) => String(1_400_000_000_001_000_000n + BigInt(n)))
    await snapshotThen(ids(99))
    expect(await members()).toMatchObject({ count: 99, capped: false })
    f.discord.route("GET", memberIdsPath(SERVER, MOD), { status: 200, json: ids(100) })
    expect(await members()).toMatchObject({ count: 100, capped: true })
  })

  test("stores nothing: the snapshot and the users stay as they were", async () => {
    await snapshotThen([ALICE])
    const before = { snapshot: stored(), users: storedUsersOf(f) }
    await members()
    expect({ snapshot: stored(), users: storedUsersOf(f) }).toEqual(before)
  })

  test("takes a list that is no array as an upstream error", async () => {
    await snapshotThen({ ids: [] })
    expect((await failure(members())).code).toBe("upstream_error")
  })

  test("passes Discord's refusal on", async () => {
    await snapshotThen([])
    f.discord.route("GET", memberIdsPath(SERVER, MOD), { status: 403, json: { code: 0, message: "Missing Access" } })
    expect((await failure(members())).code).toBe("forbidden")
  })
})
