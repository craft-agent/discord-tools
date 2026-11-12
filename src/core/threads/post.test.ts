import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { idTime } from "../chats/format"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { ME, SERVER } from "../discord/objects.testing"
import { POST_CREATED_NOTE, POST_UNSTORED_NOTE } from "./post"
import {
  BUG,
  createPostsFixture,
  IDEA,
  NEW_POST,
  POST,
  postObject,
  postPath,
  starterObject,
  STRICT_FORUM,
  TAGGED_FORUM,
  TEXT,
  type PostsFixture,
} from "./post.testing"
import { NAME } from "./threads.testing"

let f: PostsFixture

beforeEach(async () => {
  f = await createPostsFixture()
})

afterEach(() => f.dispose())

/** The JSON body of the one write the fake Discord received. */
const sentBody = () => JSON.parse(f.writes()[0]!.body!) as Record<string, unknown>

/** Makes Discord answer a post with the post and, when `starter` is true, its first message nested in it. */
function serve(starter: boolean, forum = TAGGED_FORUM) {
  f.discord.route("POST", postPath(forum), {
    status: 200,
    json: { ...postObject(NEW_POST, forum), ...(starter ? { message: starterObject() } : {}) },
  })
}

describe("the request", () => {
  test("posts the name, no tags and the text's message once to the forum's threads, with the forum's page as referer", async () => {
    serve(true)
    await f.post(POST)
    expect(f.writes().map((request) => `${request.method} ${request.path}`)).toEqual([`POST ${postPath()}`])
    expect(sentBody()).toEqual({
      name: NAME,
      applied_tags: [],
      message: { content: TEXT, flags: 0, allowed_mentions: { parse: ["users"], replied_user: false } },
    })
    expect(headerOf(f.writes()[0]!, "referer")).toContain(`/channels/${SERVER}/${TAGGED_FORUM}`)
    expect(f.reads()).toEqual([])
  })

  test("carries no nonce, no type and no archive time", async () => {
    serve(true)
    await f.post({ ...POST, tags: [BUG] })
    expect(Object.keys(sentBody()).sort()).toEqual(["applied_tags", "message", "name"])
    expect(Object.keys(sentBody().message as object).sort()).toEqual(["allowed_mentions", "content", "flags"])
  })

  test("carries the tags in the order given", async () => {
    serve(true)
    await f.post({ ...POST, tags: [IDEA, BUG] })
    expect(sentBody().applied_tags).toEqual([IDEA, BUG])
  })

  test("silent sets the flag that suppresses notifications", async () => {
    serve(true)
    await f.post({ ...POST, silent: true })
    expect(sentBody().message).toMatchObject({ flags: 4096 })
  })

  test.each([
    [{ mass_mentions: true }, ["users", "roles", "everyone"]],
    [{ mass_mentions: false }, ["users"]],
    [{}, ["users"]],
  ])("%j lets mentions of %j notify", async (extra, parse) => {
    serve(true)
    await f.post({ ...POST, ...extra })
    expect(sentBody().message).toMatchObject({ allowed_mentions: { parse, replied_user: false } })
  })

  test("sends the name and the text exactly as given", async () => {
    const name = ` ${"é".repeat(98)} `
    const text = "  @everyone <@&123> kept  \n\n"
    serve(true)
    await f.post({ ...POST, name, text })
    expect(sentBody()).toMatchObject({ name, message: { content: text } })
  })

  test("goes to a forum that requires a tag when one is given", async () => {
    serve(true, STRICT_FORUM)
    await f.post({ ...POST, channel: STRICT_FORUM, tags: [BUG] })
    expect(f.writes().map((request) => request.path)).toEqual([postPath(STRICT_FORUM)])
  })

  test("is never retried when Discord refuses it or the connection is never made", async () => {
    f.discord.route("POST", postPath(), { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    expect((await failure(f.post(POST))).code).toBe("forbidden")
    expect(f.writes()).toHaveLength(1)
    f.discord.failNext({ dispatched: false })
    expect((await failure(f.post(POST))).code).not.toBe("uncertain")
    expect(f.writes()).toHaveLength(2)
    expect(f.reads()).toEqual([])
  })
})

describe("the result", () => {
  test("names the post, which is its thread and its first message", async () => {
    serve(true)
    expect(await f.post({ ...POST, tags: [BUG], silent: true })).toEqual({
      id: NEW_POST,
      channel: TAGGED_FORUM,
      server: SERVER,
      name: NAME,
      tags: [BUG],
      message: NEW_POST,
      sent_at: idTime(NEW_POST),
      silent: true,
      note: POST_CREATED_NOTE,
    })
  })

  test("takes the name and the tags Discord says, and the tags as given when it says none", async () => {
    f.discord.route("POST", postPath(), {
      status: 200,
      json: postObject(NEW_POST, TAGGED_FORUM, { name: "as Discord keeps it", applied_tags: [IDEA] }),
    })
    expect(await f.post({ ...POST, tags: [BUG] })).toMatchObject({ name: "as Discord keeps it", tags: [IDEA] })
    const { applied_tags: _, ...withoutTags } = postObject(NEW_POST)
    f.discord.route("POST", postPath(), { status: 200, json: withoutTags })
    expect(await f.post({ ...POST, tags: [BUG] })).toMatchObject({ tags: [BUG] })
    expect(await f.post(POST)).toMatchObject({ tags: [] })
  })

  test("stores the post and its first message when the answer nests it, without marking anything current", async () => {
    serve(true)
    await f.post(POST)
    expect(f.row(NEW_POST)).toMatchObject({ type: 11, name: NAME, parent: TAGGED_FORUM })
    expect(f.row(NEW_POST)!.thread).toContain(`"owner":"${ME}"`)
    expect(f.message(NEW_POST)).toEqual({ channel: NEW_POST, content: TEXT, from_me: 1 })
    expect(f.isCurrent(NEW_POST)).toBe(false)
    expect(f.isCurrent(TAGGED_FORUM)).toBe(false)
    expect(f.reads()).toEqual([])
  })

  test("stores the post alone when the answer nests no first message", async () => {
    serve(false)
    expect(await f.post(POST)).toMatchObject({ id: NEW_POST, message: NEW_POST, note: POST_CREATED_NOTE })
    expect(f.row(NEW_POST)).toMatchObject({ type: 11, parent: TAGGED_FORUM })
    expect(f.message(NEW_POST)).toBeUndefined()
  })

  test.each([
    ["another message's id", starterObject(NEW_POST, { id: "1400000000000000251" })],
    ["another channel", starterObject(NEW_POST, { channel_id: TAGGED_FORUM })],
    ["another author", starterObject(NEW_POST, { author: { id: "1400000000000000002" } })],
    ["no object", "text"],
  ])("leaves out a first message with %s", async (_, message) => {
    f.discord.route("POST", postPath(), { status: 200, json: { ...postObject(), message } })
    expect(await f.post(POST)).toMatchObject({ id: NEW_POST, note: POST_CREATED_NOTE })
    expect(f.row(NEW_POST)).toBeDefined()
    expect(f.message(NEW_POST)).toBeUndefined()
    expect(f.message("1400000000000000251")).toBeUndefined()
  })

  test("is reported as created even when the mirror cannot store the post", async () => {
    f.discord.route("POST", postPath(), () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE INSERT ON channels BEGIN SELECT RAISE(ABORT, 'full'); END"))
      return { status: 200, json: { ...postObject(), message: starterObject() } }
    })
    const result = await f.post(POST)
    expect(result).toMatchObject({ id: NEW_POST, note: POST_UNSTORED_NOTE })
    expect(result.errors).toEqual({ store: expect.stringContaining("full") })
    expect(f.row(NEW_POST)).toBeUndefined()
    expect(f.message(NEW_POST)).toBeUndefined()
    expect(f.reads()).toEqual([])
  })
})
