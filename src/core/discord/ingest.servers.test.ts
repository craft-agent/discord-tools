import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestServers, ingestUsers } from "./ingest"
import { createTestMirror, rowById, rowsOf, type TestMirror } from "./mirror.testing"
import { ALICE, BOB, ctxAt, NOW, serverObject, SERVER, userObject } from "./objects.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

describe("ingestServers", () => {
  test("stores a server with its raw object, keeping the id exact above 2^53", () => {
    const entry = serverObject(SERVER, { name: "Made up", icon: "abc", owner: true })
    const counts = t.write(() => ingestServers(t.mirror, ctxAt(), [entry]))
    expect(counts).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(rowById(t.mirror, "servers", SERVER)).toMatchObject({
      id: SERVER,
      name: "Made up",
      icon: "abc",
      owner: 1,
      raw: JSON.stringify(entry),
      updated: NOW,
    })
  })

  test("replaces name and icon but keeps the owner when the new entry lacks it", () => {
    t.write(() => ingestServers(t.mirror, ctxAt(), [serverObject(SERVER, { owner: true, icon: "old" })]))
    const { owner: _owner, ...withoutOwner } = serverObject(SERVER, { name: "Renamed" })
    t.write(() => ingestServers(t.mirror, ctxAt(2), [withoutOwner]))
    expect(rowById(t.mirror, "servers", SERVER)).toMatchObject({ name: "Renamed", icon: null, owner: 1, updated: 2 })
    t.write(() => ingestServers(t.mirror, ctxAt(3), [serverObject(SERVER, { owner: false })]))
    expect(rowById(t.mirror, "servers", SERVER)).toMatchObject({ owner: 0 })
  })

  test("skips entries without a valid id and counts them", () => {
    const entries = [serverObject("12"), { name: "no id" }, null, "text", serverObject("0123"), serverObject(SERVER)]
    const counts = t.write(() => ingestServers(t.mirror, ctxAt(), entries))
    expect(counts).toEqual({ stored: 2, deleted: 0, skipped: 4 })
    expect(rowsOf(t.mirror, "SELECT count(*) AS n FROM servers")).toEqual([{ n: 2 }])
  })
})

describe("ingestUsers", () => {
  test("stores username, global name, bot flag and the raw object", () => {
    const alice = userObject(ALICE, { global_name: "Alice", bot: false })
    const bot = userObject(BOB, { bot: true })
    const counts = t.write(() => ingestUsers(t.mirror, ctxAt(), [alice, bot, { id: "x" }]))
    expect(counts).toEqual({ stored: 2, deleted: 0, skipped: 1 })
    expect(rowById(t.mirror, "users", ALICE)).toMatchObject({
      id: ALICE,
      username: alice.username,
      global_name: "Alice",
      bot: 0,
      raw: JSON.stringify(alice),
    })
    expect(rowById(t.mirror, "users", BOB)).toMatchObject({ bot: 1, global_name: null })
  })

  test("replaces a user's fields on a later sighting", () => {
    t.write(() => ingestUsers(t.mirror, ctxAt(), [userObject(ALICE, { global_name: "Alice" })]))
    t.write(() => ingestUsers(t.mirror, ctxAt(5), [userObject(ALICE, { username: "renamed", global_name: null })]))
    expect(rowById(t.mirror, "users", ALICE)).toMatchObject({ username: "renamed", global_name: null, updated: 5 })
  })
})
