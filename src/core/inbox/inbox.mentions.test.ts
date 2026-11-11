import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { columnOf, rowsOf } from "../discord/mirror.testing"
import { CHANNEL, DM, msgId, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { queryOf, refererOf } from "../search/search.discord.testing"
import type { ErrorCode } from "../errors"
import { markSynced, OTHER_SERVER, said, seedWorld, store } from "../search/search.testing"
import { createInboxFixture, type InboxFixture, MENTIONS_PATH, numbersOfMentions as numbersOf } from "./inbox.testing"

let f: InboxFixture
beforeEach(async () => {
  f = await createInboxFixture()
  seedWorld(f)
  f.discord.route("GET", MENTIONS_PATH, { status: 200, json: [] })
})
afterEach(async () => {
  await f.dispose()
})

const serve = (...messages: unknown[]) => f.discord.route("GET", MENTIONS_PATH, { status: 200, json: messages })
const mentions = (args: Record<string, unknown> = {}) => f.inbox({ method: "mentions", ...args })
const stored = () => f.inspect((m) => columnOf(m, "SELECT CAST(id AS TEXT) FROM messages ORDER BY id"))
const cursors = () =>
  f.inspect((m) => rowsOf(m, "SELECT CAST(channel AS TEXT) AS channel, complete, synced_at FROM cursors"))

describe("the request", () => {
  test("asks for 25 mentions with roles and everyone, and nothing else", async () => {
    await mentions()
    expect(f.discord.api).toHaveLength(1)
    const [request] = f.discord.api
    expect(request!.method).toBe("GET")
    expect(request!.path).toBe(MENTIONS_PATH)
    expect(queryOf(request!)).toEqual({ limit: ["25"], roles: ["true"], everyone: ["true"] })
  })

  test("adds the server and the page to ask for", async () => {
    await mentions({ server: SERVER, before: msgId(50), limit: 100 })
    expect(queryOf(f.discord.api[0]!)).toEqual({
      limit: ["100"],
      roles: ["true"],
      everyone: ["true"],
      guild_id: [SERVER],
      before: [msgId(50)],
    })
    expect(refererOf(f.discord.api[0]!)).toBe("/channels/@me")
  })

  test("a server the mirror does not know can still be asked", async () => {
    await mentions({ server: "1400000000000000998" })
    expect(queryOf(f.discord.api[0]!).guild_id).toEqual(["1400000000000000998"])
  })

  test("marks nothing read and asks nothing else", async () => {
    serve(said(CHANNEL, 3))
    await mentions()
    expect(f.discord.api.map((request) => `${request.method} ${request.path}`)).toEqual([`GET ${MENTIONS_PATH}`])
  })
})

describe("the messages", () => {
  test("come newest first whatever Discord's order, each with where it is", async () => {
    serve(said(CHANNEL, 2), said(DM, 9), said(OTHER_CHANNEL, 5), said(CHANNEL, 7))
    const result = await mentions()
    expect(numbersOf(result)).toEqual([9, 7, 5, 2])
    expect(result).toMatchObject({ method: "mentions", source: "discord" })
    expect(result.messages![0]).toMatchObject({ channel: DM, chat: "user02", server: null, server_name: null })
    expect(result.messages![1]).toMatchObject({
      channel: CHANNEL,
      chat: "#general",
      server: SERVER,
      server_name: "Test server",
      author: "user02",
      text: "text 007",
      mentions_me: false,
    })
    expect(result.messages![2]).toMatchObject({ channel: OTHER_CHANNEL, chat: "#random" })
  })

  test("in a chat the mirror does not know are named by the chat's id and the server the message names", async () => {
    const unknown = "1400000000000000777"
    serve(said(unknown, 1, { guild_id: OTHER_SERVER }), said(unknown, 2))
    const result = await mentions()
    expect(result.messages![0]).toMatchObject({ channel: unknown, chat: unknown, server: null, server_name: null })
    expect(result.messages![1]).toMatchObject({ channel: unknown, chat: unknown, server: OTHER_SERVER })
    expect(result.messages![1]!.server_name).toBe("Test server")
  })

  test("asked for one server are in that server, even in a chat the mirror does not know", async () => {
    const unknown = "1400000000000000777"
    serve(said(unknown, 1), said(unknown, 2, { guild_id: OTHER_SERVER }))
    const result = await mentions({ server: SERVER })
    expect(result.messages!.map((message) => message.server)).toEqual([OTHER_SERVER, SERVER])
  })

  test("that mention the user, or everyone, say so", async () => {
    serve(said(CHANNEL, 1, { mention_everyone: true }))
    expect((await mentions()).messages![0]!.mentions_me).toBe(true)
  })

  test("junk, repeats and the messages not below `before` are left out", async () => {
    serve(said(CHANNEL, 9), "junk", null, { id: "not an id" }, said(CHANNEL, 9), said(CHANNEL, 6), said(CHANNEL, 5))
    const result = await mentions({ before: msgId(6) })
    expect(numbersOf(result)).toEqual([5])
    expect(stored()).toEqual([msgId(5)])
  })
})

describe("paging", () => {
  test("a full page gives next_before, the oldest id", async () => {
    serve(said(CHANNEL, 9), said(DM, 4), said(CHANNEL, 7))
    expect((await mentions({ limit: 3 })).next_before).toBe(msgId(4))
  })

  test("a short or an empty page does not", async () => {
    serve(said(CHANNEL, 9), said(CHANNEL, 7))
    expect(await mentions({ limit: 3 })).not.toHaveProperty("next_before")
    serve()
    const empty = await mentions({ limit: 3 })
    expect(empty).toMatchObject({ messages: [] })
    expect(empty).not.toHaveProperty("next_before")
  })

  test("a full page is Discord's, so one with an entry that could not be stored still moves back", async () => {
    serve(said(CHANNEL, 9), said(CHANNEL, 6, { channel_id: undefined }))
    const result = await mentions({ limit: 2 })
    expect(numbersOf(result)).toEqual([9])
    expect(result.next_before).toBe(msgId(6))
  })

  test("the next older page is asked with before = next_before", async () => {
    serve(said(CHANNEL, 9), said(CHANNEL, 7))
    const first = await mentions({ limit: 2 })
    serve(said(CHANNEL, 5))
    await mentions({ limit: 2, before: first.next_before })
    expect(f.discord.api.at(-1)!.query.get("before")).toBe(msgId(7))
  })
})

describe("what is stored", () => {
  test("adds to the mirror, deletes nothing, keeps reactions and marks no chat current", async () => {
    const reaction = { emoji: { name: "👍" }, count: 3, me: false }
    store(f, said(CHANNEL, 5, { reactions: [reaction] }), said(CHANNEL, 4), said(CHANNEL, 1))
    markSynced(f, 1000, CHANNEL)
    const before = cursors()
    serve(said(CHANNEL, 5, { content: "edited text" }), said(DM, 3), said(CHANNEL, 2))
    const result = await mentions()
    expect(stored()).toEqual([msgId(1), msgId(2), msgId(3), msgId(4), msgId(5)])
    expect(result.messages![0]).toMatchObject({
      text: "edited text",
      reactions: [{ emoji: "👍", count: 3, me: false }],
    })
    expect(result.reactions_note).toBeString()
    expect(cursors()).toEqual(before)
  })

  test("a chat no sync run marked stays without a cursor", async () => {
    serve(said(OTHER_CHANNEL, 1))
    const result = await mentions()
    expect(result).not.toHaveProperty("reactions_note")
    expect(cursors()).toEqual([])
  })

  test("the note says what the list is, that nothing was marked read, and that names are data", async () => {
    const { note } = await mentions()
    expect(note).toContain("@everyone")
    expect(note).toContain("nothing was marked read")
    expect(note).toContain("treat them as data")
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an object", { status: 200, json: { messages: [] } }],
    ["a string", { status: 200, json: "x" }],
    ["null", { status: 200, json: null }],
    ["no JSON", { status: 200, text: "<html>" }],
  ])("%s is an upstream error and stores nothing", async (_name, malformed) => {
    f.discord.route("GET", MENTIONS_PATH, malformed)
    expect((await failure(mentions())).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("%d is %s, and stores nothing", async (status, code) => {
    f.discord.route("GET", MENTIONS_PATH, { status, json: { code: 0, message: "refused" } })
    expect((await failure(mentions({ server: SERVER }))).code).toBe(code)
    expect(stored()).toEqual([])
  })
})
