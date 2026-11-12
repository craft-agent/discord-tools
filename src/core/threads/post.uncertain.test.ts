import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { idTime } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ALICE, channelObject } from "../discord/objects.testing"
import {
  createPostsFixture,
  NEW_POST,
  POST,
  postObject,
  postPath,
  postSearchPath,
  starterObject,
  TAGGED_FORUM,
  type PostsFixture,
} from "./post.testing"
import { discordPostCreate } from "./post-tool"
import { NAME } from "./threads.testing"

let f: PostsFixture

beforeEach(async () => {
  f = await createPostsFixture()
})

afterEach(() => f.dispose())

/** Makes the thread search answer with these threads, as Discord's does. */
const serveSearch = (threads: unknown[]) =>
  f.discord.route("GET", postSearchPath(), { status: 200, json: { threads, first_messages: [], has_more: false } })

const OLDER = "1400000000000000249"
const OTHERS = "1400000000000000248"
const RENAMED = "1400000000000000247"

describe("a post whose outcome is unknown", () => {
  test.each([
    ["a server error", () => f.discord.route("POST", postPath(), { status: 500, json: { message: "oops" } })],
    ["a failure after the request left", () => f.discord.failNext({ dispatched: true, message: "timed out" })],
    ["an answer that is not JSON", () => f.discord.route("POST", postPath(), { status: 200, text: "<html>" })],
    ["an answer without a thread", () => f.discord.route("POST", postPath(), { status: 200, json: {} })],
    [
      "a channel that is not a thread",
      () =>
        f.discord.route("POST", postPath(), {
          status: 200,
          json: channelObject(NEW_POST, { parent_id: TAGGED_FORUM }),
        }),
    ],
    [
      "a thread of another channel",
      () => f.discord.route("POST", postPath(), { status: 200, json: postObject(NEW_POST, ALICE) }),
    ],
    [
      "a private thread",
      () =>
        f.discord.route("POST", postPath(), { status: 200, json: postObject(NEW_POST, TAGGED_FORUM, { type: 12 }) }),
    ],
    [
      "an answer that is only the message",
      () => f.discord.route("POST", postPath(), { status: 200, json: starterObject() }),
    ],
  ])("%s is uncertain, never retried, never stored, and read back once", async (_, serve) => {
    serve()
    serveSearch([])
    const error = await failure(f.post(POST))
    expect(error).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { read_back: { found: [] } },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.reads()).toHaveLength(1)
    expect(f.row(NEW_POST)).toBeUndefined()
    expect(f.message(NEW_POST)).toBeUndefined()
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("POST", postPath(), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordPostCreate
      .execute(POST, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { read_back: "skipped" } })
    expect(f.reads()).toHaveLength(0)
  })
})

describe("the read-back of a post", () => {
  beforeEach(() => f.discord.route("POST", postPath(), { status: 502, json: {} }))

  test("asks for the forum's newest active posts once", async () => {
    serveSearch([])
    await failure(f.post(POST))
    const [request] = f.reads()
    expect(request!.path).toBe(postSearchPath())
    expect(Object.fromEntries(request!.query)).toMatchObject({
      sort_by: "creation_time",
      sort_order: "desc",
      archived: "false",
    })
    expect(f.reads()).toHaveLength(1)
  })

  test("lists only the account's own posts with exactly that name, newest first", async () => {
    serveSearch([
      postObject(NEW_POST),
      postObject(OTHERS, TAGGED_FORUM, { owner_id: ALICE }),
      postObject(RENAMED, TAGGED_FORUM, { name: `${NAME} 2` }),
      postObject(OLDER),
    ])
    expect(await failure(f.post(POST))).toMatchObject({
      code: "uncertain",
      details: {
        read_back: {
          found: [
            { id: NEW_POST, name: NAME, created_at: idTime(NEW_POST) },
            { id: OLDER, name: NAME, created_at: idTime(OLDER) },
          ],
        },
      },
    })
    expect(f.writes()).toHaveLength(1)
  })

  test("finds nothing when no such post is listed", async () => {
    serveSearch([postObject(OTHERS, TAGGED_FORUM, { owner_id: ALICE })])
    expect(await failure(f.post(POST))).toMatchObject({ details: { read_back: { found: [] } } })
  })

  test.each([
    ["a failing search", { status: 500, json: {} }],
    ["an answer of an unexpected shape", { status: 200, json: { threads: "none" } }],
    [
      "a thread of another channel",
      { status: 200, json: { threads: [postObject(OTHERS, ALICE)], first_messages: [] } },
    ],
  ])("%s is reported as failed", async (_, answer) => {
    f.discord.route("GET", postSearchPath(), answer)
    expect(await failure(f.post(POST))).toMatchObject({ code: "uncertain", details: { read_back: "failed" } })
    expect(f.reads()).toHaveLength(1)
    expect(f.writes()).toHaveLength(1)
  })
})
