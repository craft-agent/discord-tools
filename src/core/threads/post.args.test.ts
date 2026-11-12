import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import {
  BUG,
  createPostsFixture,
  IDEA,
  POST,
  STRANGER,
  STRICT_BARE_FORUM,
  STRICT_FORUM,
  TAGGED_FORUM,
  type PostsFixture,
} from "./post.testing"
import { ANNOUNCEMENT, CATEGORY, DM, FORUM, MEDIA, OLD_THREAD } from "./threads.testing"

let f: PostsFixture

beforeEach(async () => {
  f = await createPostsFixture()
})

afterEach(() => f.dispose())

/** Calls the tool with `extra` over a valid call and checks it failed with `code` before any request. */
async function refused(extra: Record<string, unknown>, code: ErrorCode) {
  const error = await failure(f.post({ ...POST, ...extra }))
  expect(error.code).toBe(code)
  expect(f.discord.api).toEqual([])
  return error
}

describe("arguments the tool refuses before anything is requested", () => {
  test.each([
    ["a channel that is a name", { channel: "ideas" }],
    ["an empty name", { name: "" }],
    ["a name of whitespace only", { name: " \n\t " }],
    ["a name over 100 characters", { name: "a".repeat(101) }],
    ["no text", { text: undefined }],
    ["an empty text", { text: "" }],
    ["a text of whitespace only", { text: " \n " }],
    ["a text over 4000 characters", { text: "a".repeat(4001) }],
    ["an empty tag list", { tags: [] }],
    ["a tag that is a name", { tags: ["bug"] }],
    ["more than 5 tags", { tags: [1, 2, 3, 4, 5, 6].map((n) => `140000000000000030${n}`) }],
    ["a tag given twice", { tags: [BUG, BUG] }],
    ["an auto_archive, which a post does not take", { auto_archive: 60 }],
    ["an unknown argument", { type: 11 }],
  ])("%s is invalid_argument", async (_, extra) => {
    await refused(extra, "invalid_argument")
  })
})

describe("channels the mirror does not allow a post in", () => {
  test.each([
    ["a text channel", CHANNEL, "takes a thread, not a post"],
    ["an announcement channel", ANNOUNCEMENT, "takes a thread, not a post"],
    ["a category", CATEGORY, "not a forum or media channel"],
    ["a thread", OLD_THREAD, "not a forum or media channel"],
    ["a DM", DM, "not a forum or media channel"],
  ])("%s is invalid_argument and says what to use", async (_, channel, what) => {
    const error = await refused({ channel }, "invalid_argument")
    expect(error.message).toContain(what)
    expect(error.message).toContain("forum or media channel")
  })

  test("a text channel is pointed to discord_thread_create", async () => {
    expect((await refused({ channel: CHANNEL }, "invalid_argument")).message).toContain("discord_thread_create")
  })

  test("a channel the mirror does not hold is not_found", async () => {
    await refused({ channel: "1400000000000000999" }, "not_found")
  })

  test("a forum and a media channel are allowed through to the request", async () => {
    for (const channel of [FORUM, MEDIA]) {
      expect((await failure(f.post({ ...POST, channel }))).code).not.toBe("invalid_argument")
    }
    expect(f.writes()).toHaveLength(2)
  })
})

describe("tags the mirror does not list", () => {
  test("a tag the forum does not list is invalid_argument and lists its tags", async () => {
    const error = await refused({ tags: [BUG, STRANGER] }, "invalid_argument")
    expect(error.message).toContain(STRANGER)
    expect(error.message).toContain(`${IDEA} (Idea)`)
  })

  test("tags in a forum whose tags the mirror does not hold are not_found and say how to list them", async () => {
    for (const channel of [FORUM, MEDIA]) {
      const error = await refused({ channel, tags: [BUG] }, "not_found")
      expect(error.message).toContain("discord_chat_read method threads")
    }
  })

  test("a forum that requires a tag refuses a post without one, with its tags listed", async () => {
    const error = await refused({ channel: STRICT_FORUM }, "invalid_argument")
    expect(error.message).toContain(`${BUG} (Bug)`)
  })

  test("a forum that requires a tag and whose tags are unknown still refuses a post without one", async () => {
    const error = await refused({ channel: STRICT_BARE_FORUM }, "invalid_argument")
    expect(error.message).toContain("method threads")
  })

  test("a forum that does not require a tag takes a post without one", async () => {
    f.discord.failNext({ dispatched: false })
    expect((await failure(f.post({ ...POST, channel: TAGGED_FORUM }))).code).not.toBe("invalid_argument")
    expect(f.writes()).toHaveLength(1)
  })
})
