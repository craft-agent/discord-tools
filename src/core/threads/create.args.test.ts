import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, msgId } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import {
  ANNOUNCEMENT,
  CATEGORY,
  createThreadsFixture,
  DM,
  ELSEWHERE,
  FORUM,
  MEDIA,
  NAME,
  NEWS_MESSAGE,
  OLD_THREAD,
  SAID,
  type ThreadsFixture,
} from "./threads.testing"

let f: ThreadsFixture

beforeEach(async () => {
  f = await createThreadsFixture()
})

afterEach(() => f.dispose())

const base = { channel: CHANNEL, name: NAME }

/** Calls the tool with `extra` over a valid call and checks it failed with `code` before any request. */
async function refused(extra: Record<string, unknown>, code: ErrorCode) {
  const error = await failure(f.create({ ...base, ...extra }))
  expect(error.code).toBe(code)
  expect(f.discord.api).toEqual([])
  return error
}

describe("arguments the tool refuses before anything is requested", () => {
  test.each([
    ["a channel that is a name", { channel: "general" }],
    ["a message that is a name", { message: "latest" }],
    ["an empty name", { name: "" }],
    ["a name of whitespace only", { name: " \n\t " }],
    ["a name over 100 characters", { name: "a".repeat(101) }],
    ["an archive time Discord does not take", { auto_archive: 30 }],
    ["a private thread from a message", { message: SAID, private: true }],
    ["an unknown argument", { topic: "x" }],
  ])("%s is invalid_argument", async (_, extra) => {
    await refused(extra, "invalid_argument")
  })

  test("a private thread from a message says what to change", async () => {
    const error = await refused({ message: SAID, private: true }, "invalid_argument")
    expect(error.message).toContain("leave out `private`")
  })
})

describe("channels the mirror does not allow a thread in", () => {
  test.each([
    ["a forum", FORUM, "a forum or media channel, which takes a post, not a thread"],
    ["a media channel", MEDIA, "a forum or media channel, which takes a post, not a thread"],
    ["a category", CATEGORY, "not a text or announcement channel"],
    ["a thread", OLD_THREAD, "a thread, which cannot hold another"],
    ["a DM", DM, "a DM or group DM"],
  ])("%s is invalid_argument and says what it is", async (_, channel, what) => {
    const error = await refused({ channel }, "invalid_argument")
    expect(error.message).toContain(what)
    expect(error.message).toContain("text or announcement channel")
  })

  test("a private thread in an announcement channel is invalid_argument", async () => {
    const error = await refused({ channel: ANNOUNCEMENT, private: true }, "invalid_argument")
    expect(error.message).toContain("text channel")
  })

  test("a channel the mirror does not hold is not_found", async () => {
    await refused({ channel: "1400000000000000999" }, "not_found")
  })
})

describe("messages the mirror does not hold in the channel", () => {
  test.each([
    ["a message the mirror does not hold", msgId(999)],
    ["a message of another channel the mirror knows", NEWS_MESSAGE],
    ["a message of a channel the mirror does not know", ELSEWHERE],
  ])("%s is not_found", async (_, message) => {
    const error = await refused({ message }, "not_found")
    expect(error.message).toContain(`channel ${CHANNEL}`)
  })
})
