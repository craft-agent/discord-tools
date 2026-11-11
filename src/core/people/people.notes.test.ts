import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ingestUsers } from "../discord/ingest"
import { columnOf } from "../discord/mirror.testing"
import { ALICE, BOB, userObject } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { NOTES_PATH } from "./notes"
import { CAROL, createPeopleFixture, DAVE, type PeopleFixture, seedUsers } from "./people.testing"

let f: PeopleFixture
beforeEach(async () => {
  f = await createPeopleFixture()
})
afterEach(async () => {
  await f.dispose()
})

const serve = (notes: unknown) => f.discord.route("GET", NOTES_PATH, { status: 200, json: notes })
const serveOne = (user: string, answer: Record<string, unknown>) =>
  f.discord.route("GET", `${NOTES_PATH}/${user}`, { status: 200, json: answer })
const notes = (args: Record<string, unknown> = {}) => f.people({ method: "notes", ...args })
const users = (result: { notes?: { user: string }[] }) => result.notes?.map((item) => item.user)
const storedUsers = () => f.inspect((m) => columnOf(m, "SELECT CAST(id AS TEXT) FROM users ORDER BY id"))
const requests = () => f.discord.api.map((request) => `${request.method} ${request.path}`)

describe("every note", () => {
  test("is one GET of the list of notes", async () => {
    serve({})
    expect(await notes()).toMatchObject({ notes: [], count: 0 })
    expect(requests()).toEqual([`GET ${NOTES_PATH}`])
    expect([...f.discord.api[0]!.query.keys()]).toEqual([])
  })

  test("is listed with the name the mirror holds, ordered by name ignoring case, unknown names last, then id", async () => {
    f.seed((m) =>
      ingestUsers(m, f.ingestContext(), [
        userObject(ALICE, { username: "alice" }),
        userObject(BOB, { username: "bob", global_name: "Bob B" }),
      ]),
    )
    serve({ [DAVE]: "four", [BOB]: "two", [ALICE]: "one", [CAROL]: "three" })
    const result = await notes()
    expect(users(result)).toEqual([ALICE, BOB, CAROL, DAVE])
    expect(result.notes).toEqual([
      { user: ALICE, name: "alice", username: "alice", note: "one" },
      { user: BOB, name: "Bob B", username: "bob", note: "two" },
      { user: CAROL, name: null, username: null, note: "three" },
      { user: DAVE, name: null, username: null, note: "four" },
    ])
    expect(result.count).toBe(4)
  })

  test("leaves out an entry without a user id or a text", async () => {
    serve({ [ALICE]: "kept", [BOB]: "", [CAROL]: null, [DAVE]: 5, name: "no id", "0": "bad id" })
    const result = await notes()
    expect(users(result)).toEqual([ALICE])
    expect(result.count).toBe(1)
  })

  test("stores nothing in the mirror", async () => {
    serve({ [ALICE]: "kept" })
    await notes()
    expect(storedUsers()).toEqual([])
  })
})

describe("the note on one user", () => {
  test("is one GET of that user's note, for a user the mirror knows", async () => {
    seedUsers(f, ALICE)
    serveOne(ALICE, { note: "likes tea", note_user_id: ALICE, user_id: "1400000000000000001" })
    const result = await notes({ user: ALICE })
    expect(requests()).toEqual([`GET ${NOTES_PATH}/${ALICE}`])
    expect(result).toMatchObject({
      method: "notes",
      notes: [{ user: ALICE, name: "user02", username: "user02", note: "likes tea" }],
      count: 1,
    })
  })

  test("is null when Discord answers not found, and when the note is empty", async () => {
    seedUsers(f, ALICE, BOB)
    serveOne(BOB, { note: "", note_user_id: BOB })
    expect(await notes({ user: ALICE })).toMatchObject({ notes: [{ user: ALICE, note: null }], count: 0 })
    expect(await notes({ user: BOB })).toMatchObject({ notes: [{ user: BOB, note: null }], count: 0 })
    expect(requests()).toEqual([`GET ${NOTES_PATH}/${ALICE}`, `GET ${NOTES_PATH}/${BOB}`])
  })

  test("of a user the mirror does not know is not_found, and nothing is requested", async () => {
    seedUsers(f, ALICE)
    const error = await failure(notes({ user: BOB }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain(BOB)
    expect(f.discord.api).toEqual([])
  })

  test("with an answer that is not an object is an upstream error", async () => {
    seedUsers(f, ALICE)
    f.discord.route("GET", `${NOTES_PATH}/${ALICE}`, { status: 200, json: [] })
    expect((await failure(notes({ user: ALICE }))).code).toBe("upstream_error")
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an array", { status: 200, json: [] }],
    ["null", { status: 200, json: null }],
    ["no JSON", { status: 200, text: "<html>" }],
  ])("%s for every note is an upstream error", async (_name, malformed) => {
    f.discord.route("GET", NOTES_PATH, malformed)
    expect((await failure(notes())).code).toBe("upstream_error")
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [500, "upstream_error"],
  ])("%d is %s, for every note and for one", async (status, code) => {
    seedUsers(f, ALICE)
    const refused = { status, json: { code: 0, message: "refused" } }
    f.discord.route("GET", NOTES_PATH, refused).route("GET", `${NOTES_PATH}/${ALICE}`, refused)
    expect((await failure(notes())).code).toBe(code)
    expect((await failure(notes({ user: ALICE }))).code).toBe(code)
  })

  test("is said to be private to the user, never to be shared unasked, with the names data", async () => {
    serve({})
    const { note } = await notes()
    expect(note).toContain("private")
    expect(note).toContain("never send or share them unless the user asks")
    expect(note).toContain(UNTRUSTED_NOTE)
  })
})
