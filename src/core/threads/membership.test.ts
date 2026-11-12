import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { THREAD_JOINED_NOTE, THREAD_LEFT_NOTE } from "./membership"
import {
  createMembershipFixture,
  FORUM_POST,
  type MembershipFixture,
  membershipPath,
  NEWS_THREAD,
  PRIVATE_THREAD,
} from "./membership.testing"
import { discordThreadJoin } from "./membership-tool"
import { ANNOUNCEMENT, CATEGORY, DM, FORUM, MEDIA, OLD_THREAD } from "./threads.testing"

let f: MembershipFixture

beforeEach(async () => {
  f = await createMembershipFixture()
})

afterEach(() => f.dispose())

const args = (thread = OLD_THREAD, extra: Record<string, unknown> = {}) => ({ thread, ...extra })

describe("joining a thread", () => {
  test("puts the membership once, with no query and no body, and names the thread", async () => {
    f.discord.route("PUT", membershipPath(OLD_THREAD), { status: 204 })
    expect(await f.join(args())).toEqual({
      thread: OLD_THREAD,
      channel: CHANNEL,
      server: SERVER,
      name: "old",
      joined: true,
      note: THREAD_JOINED_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PUT", path: membershipPath(OLD_THREAD) })
    expect([...request!.query.keys()]).toEqual([])
    expect(request!.body ?? "").toBe("")
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${OLD_THREAD}`)
  })

  test.each([
    ["a private thread", PRIVATE_THREAD, "secret", CHANNEL],
    ["an announcement thread", NEWS_THREAD, "news thread", ANNOUNCEMENT],
    ["a forum post", FORUM_POST, "a post", FORUM],
  ])("works on %s", async (_, thread, name, channel) => {
    f.discord.route("PUT", membershipPath(thread), { status: 204 })
    expect(await f.join(args(thread))).toMatchObject({ thread, channel, name, joined: true })
    expect(f.discord.api).toHaveLength(1)
  })

  test("takes any 2xx answer as done", async () => {
    f.discord.route("PUT", membershipPath(OLD_THREAD), { status: 200, json: {} })
    expect(await f.join(args())).toMatchObject({ joined: true })
  })

  test("writes nothing to the mirror", async () => {
    const before = f.channels()
    f.discord.route("PUT", membershipPath(OLD_THREAD), { status: 204 })
    await f.join(args())
    expect(f.channels()).toEqual(before)
    expect(f.isCurrent(OLD_THREAD)).toBe(false)
  })
})

describe("leaving a thread", () => {
  test("deletes the membership once, with no query and no body, and names the thread", async () => {
    f.discord.route("DELETE", membershipPath(PRIVATE_THREAD), { status: 204 })
    expect(await f.leave(args(PRIVATE_THREAD))).toEqual({
      thread: PRIVATE_THREAD,
      channel: CHANNEL,
      server: SERVER,
      name: "secret",
      joined: false,
      note: THREAD_LEFT_NOTE,
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: membershipPath(PRIVATE_THREAD) })
    expect([...request!.query.keys()]).toEqual([])
    expect(request!.body ?? "").toBe("")
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${PRIVATE_THREAD}`)
  })

  test("writes nothing to the mirror", async () => {
    const before = f.channels()
    f.discord.route("DELETE", membershipPath(OLD_THREAD), { status: 204 })
    await f.leave(args())
    expect(f.channels()).toEqual(before)
  })
})

describe("a call that is refused before anything leaves", () => {
  const refused = async (call: typeof f.join, input: unknown, code: string) => {
    expect(await failure(call(input))).toMatchObject({ code })
    expect(f.discord.api).toEqual([])
  }

  test.each([
    ["an unknown channel", { thread: "1400000000000000999" }, "not_found"],
    ["a thread that is a name", { thread: "general" }, "invalid_argument"],
    ["no thread", {}, "invalid_argument"],
    ["an unknown argument", { thread: OLD_THREAD, super: true }, "invalid_argument"],
  ])("%s is %s", async (_, input, code) => {
    await refused(f.join, input, code)
    await refused(f.leave, input, code)
  })

  test.each([
    ["a text channel", CHANNEL, "a text channel"],
    ["an announcement channel", ANNOUNCEMENT, "an announcement channel"],
    ["a forum", FORUM, "a forum channel"],
    ["a media channel", MEDIA, "a media channel"],
    ["a category", CATEGORY, "a category"],
    ["a DM", DM, "a DM or group DM"],
  ])("%s is invalid_argument and says what it is", async (_, thread, what) => {
    for (const call of [f.join, f.leave]) {
      const error = await failure(call(args(thread)))
      expect(error).toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining(`is ${what}, not a thread`),
      })
    }
    expect(f.discord.api).toEqual([])
  })
})

describe("a call that Discord refuses", () => {
  test.each([
    [403, "forbidden", 50001],
    [400, "invalid_argument", 50083],
    [404, "not_found", 10003],
  ])("a %i is %s with Discord's code, sent once and read back never", async (status, code, discordCode) => {
    f.discord.route("PUT", membershipPath(OLD_THREAD), { status, json: { code: discordCode, message: "no" } })
    f.discord.route("DELETE", membershipPath(OLD_THREAD), { status, json: { code: discordCode, message: "no" } })
    for (const call of [f.join, f.leave]) {
      expect(await failure(call(args()))).toMatchObject({ code, details: { discord_code: discordCode } })
    }
    expect(f.discord.api).toHaveLength(2)
    expect(f.discord.api.filter((request) => request.method === "GET")).toEqual([])
  })

  test("a connection never made is upstream_error and reads nothing back", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(f.join(args()))).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("the tools' targets", () => {
  test("name the label and the thread", async () => {
    expect(await writeTargets(discordThreadJoin, args(), f.ctx)).toEqual([`default/channel/${OLD_THREAD}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordThreadJoin, args(OLD_THREAD, { account: "nobody" }), f.ctx)).toEqual(["*"])
  })
})
