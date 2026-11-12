import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { idTime } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ALICE, CHANNEL, channelObject, msgId } from "../discord/objects.testing"
import { discordThreadCreate } from "./create-tool"
import {
  createThreadsFixture,
  fromMessagePath,
  NAME,
  NEW_THREAD,
  SAID,
  searchPath,
  startPath,
  threadObject,
  type ThreadsFixture,
} from "./threads.testing"

let f: ThreadsFixture

beforeEach(async () => {
  f = await createThreadsFixture()
})

afterEach(() => f.dispose())

const standalone = { channel: CHANNEL, name: NAME }
const fromMessage = { channel: CHANNEL, message: SAID, name: NAME }

/** Makes the thread search answer with these threads, as Discord's does. */
const serveSearch = (threads: unknown[]) =>
  f.discord.route("GET", searchPath(), { status: 200, json: { threads, first_messages: [], has_more: false } })

const OLDER = "1400000000000000219"
const OTHERS = "1400000000000000218"
const RENAMED = "1400000000000000217"

describe("a creation whose outcome is unknown", () => {
  test.each([
    ["a server error", () => f.discord.route("POST", startPath(), { status: 500, json: { message: "oops" } })],
    ["a failure after the request left", () => f.discord.failNext({ dispatched: true, message: "timed out" })],
    ["an answer that is not JSON", () => f.discord.route("POST", startPath(), { status: 200, text: "<html>" })],
    ["an answer without a thread", () => f.discord.route("POST", startPath(), { status: 200, json: {} })],
    [
      "a channel that is not a thread",
      () =>
        f.discord.route("POST", startPath(), { status: 200, json: channelObject(NEW_THREAD, { parent_id: CHANNEL }) }),
    ],
    [
      "a thread of another channel",
      () =>
        f.discord.route("POST", startPath(), {
          status: 200,
          json: threadObject(NEW_THREAD, { parent_id: "1400000000000000999" }),
        }),
    ],
  ])("%s is uncertain, never retried, never stored, and read back once", async (_, serve) => {
    serve()
    serveSearch([])
    const error = await failure(f.create(standalone))
    expect(error).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { read_back: { found: [] } },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.reads()).toHaveLength(1)
    expect(f.row(NEW_THREAD)).toBeUndefined()
  })

  test("an answer with another message's thread id is uncertain", async () => {
    f.discord.route("POST", fromMessagePath(), { status: 200, json: threadObject(msgId(3)) })
    f.discord.route("GET", `/channels/${SAID}`, { status: 404, json: { code: 10003 } })
    expect(await failure(f.create(fromMessage))).toMatchObject({
      code: "uncertain",
      details: { read_back: { found: [] } },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.reads()).toHaveLength(1)
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("POST", startPath(), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordThreadCreate
      .execute(standalone, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toHaveLength(0)
  })
})

describe("the read-back of a thread started from a message", () => {
  beforeEach(() => f.discord.route("POST", fromMessagePath(), { status: 500, json: {} }))

  test("reads the thread that has the message's id and finds it", async () => {
    f.discord.route("GET", `/channels/${SAID}`, { status: 200, json: threadObject(SAID) })
    expect(await failure(f.create(fromMessage))).toMatchObject({
      code: "uncertain",
      details: { read_back: { found: [{ id: SAID, name: NAME }] } },
    })
    expect(f.reads().map((request) => request.path)).toEqual([`/channels/${SAID}`])
  })

  test("finds nothing when Discord has no such thread", async () => {
    f.discord.route("GET", `/channels/${SAID}`, { status: 404, json: { code: 10003, message: "Unknown Channel" } })
    expect(await failure(f.create(fromMessage))).toMatchObject({ details: { read_back: { found: [] } } })
    expect(f.reads()).toHaveLength(1)
  })

  test.each([
    ["a failing read", { status: 500, json: {} }],
    ["a refusal", { status: 403, json: { code: 50001, message: "Missing Access" } }],
    ["an answer that is not a thread of the channel", { status: 200, json: threadObject(SAID, { parent_id: ALICE }) }],
    ["an answer that is not a channel", { status: 200, json: [] }],
  ])("%s is reported as failed, with nothing known", async (_, answer) => {
    f.discord.route("GET", `/channels/${SAID}`, answer)
    expect(await failure(f.create(fromMessage))).toMatchObject({ code: "uncertain", details: { read_back: "failed" } })
    expect(f.reads()).toHaveLength(1)
  })
})

describe("the read-back of a standalone thread", () => {
  beforeEach(() => f.discord.route("POST", startPath(), { status: 502, json: {} }))

  test("asks for the channel's newest active threads once", async () => {
    serveSearch([])
    await failure(f.create(standalone))
    const [request] = f.reads()
    expect(request!.path).toBe(searchPath())
    expect(Object.fromEntries(request!.query)).toMatchObject({
      sort_by: "creation_time",
      sort_order: "desc",
      archived: "false",
    })
    expect(f.reads()).toHaveLength(1)
  })

  test("lists only the account's own threads with exactly that name, newest first", async () => {
    serveSearch([
      threadObject(NEW_THREAD),
      threadObject(OTHERS, { owner_id: ALICE }),
      threadObject(RENAMED, { name: `${NAME} 2` }),
      threadObject(OLDER),
    ])
    expect(await failure(f.create(standalone))).toMatchObject({
      code: "uncertain",
      details: {
        read_back: {
          found: [
            { id: NEW_THREAD, name: NAME, created_at: idTime(NEW_THREAD) },
            { id: OLDER, name: NAME, created_at: idTime(OLDER) },
          ],
        },
      },
    })
    expect(f.row(NEW_THREAD)).toMatchObject({ name: NAME })
  })

  test("finds nothing when no such thread is listed", async () => {
    serveSearch([threadObject(OTHERS, { owner_id: ALICE })])
    expect(await failure(f.create(standalone))).toMatchObject({ details: { read_back: { found: [] } } })
  })

  test.each([
    ["a failing search", { status: 500, json: {} }],
    ["an answer of an unexpected shape", { status: 200, json: { threads: "none" } }],
    [
      "a thread of another channel",
      { status: 200, json: { threads: [threadObject(OTHERS, { parent_id: ALICE })], first_messages: [] } },
    ],
  ])("%s is reported as failed", async (_, answer) => {
    f.discord.route("GET", searchPath(), answer)
    expect(await failure(f.create(standalone))).toMatchObject({ code: "uncertain", details: { read_back: "failed" } })
    expect(f.reads()).toHaveLength(1)
    expect(f.writes()).toHaveLength(1)
  })
})
