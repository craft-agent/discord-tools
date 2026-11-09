import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, DM, msgId, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import {
  type ActionsFixture,
  createActionsFixture,
  OWN,
  reactionPath,
  REFUSED_TARGETS,
  THEIRS,
} from "./actions.testing"
import { discordReactionAdd } from "./reaction-tool"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const PARTY = `party:${msgId(50)}`
const thumbs = (count: number, me: boolean) => ({ emoji: "👍", count, me })
const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, message: OWN, emoji: "👍", ...extra })
const stored = (id = OWN) => {
  const text = f.row(id)!.reactions
  return text === null ? null : (JSON.parse(text) as unknown)
}

describe("adding a reaction", () => {
  test("puts the emoji once, percent-encoded, with the web client's query and no body", async () => {
    f.discord.route("PUT", reactionPath("👍", "/@me"), { status: 204 })
    expect(await f.react(args())).toEqual({
      id: OWN,
      channel: CHANNEL,
      emoji: "👍",
      note: expect.stringContaining("added on Discord"),
    })
    const [request, ...rest] = f.writes()
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PUT", path: reactionPath("👍", "/@me") })
    expect(request!.path).toContain("%F0%9F%91%8D")
    expect(request!.query.get("location")).toBe("Message")
    expect(request!.query.get("type")).toBe("0")
    expect(request!.body ?? "").toBe("")
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
    expect(f.readBacks()).toHaveLength(0)
  })

  test("counts the account in on an emoji that others already used", async () => {
    f.discord.route("PUT", reactionPath("👍", "/@me"), { status: 204 })
    await f.react(args())
    expect(stored()).toEqual([thumbs(3, true)])
  })

  test("works on someone else's message that has no stored reactions", async () => {
    f.discord.route("PUT", reactionPath("🎉", "/@me", THEIRS), { status: 204 })
    await f.react(args({ message: THEIRS, emoji: "🎉" }))
    expect(stored(THEIRS)).toEqual([{ emoji: "🎉", count: 1, me: true }])
  })

  test("works on someone else's message that has some", async () => {
    f.setReactions(THEIRS, [{ emoji: "🎉", count: 1, me: false }])
    f.discord.route("PUT", reactionPath("👍", "/@me", THEIRS), { status: 204 })
    await f.react(args({ message: THEIRS }))
    expect(stored(THEIRS)).toEqual([{ emoji: "🎉", count: 1, me: false }, thumbs(1, true)])
  })

  test("is sent even when the mirror shows it already, and changes nothing", async () => {
    f.setReactions(OWN, [thumbs(2, true)])
    f.discord.route("PUT", reactionPath("👍", "/@me"), { status: 204 })
    await f.react(args())
    expect(f.writes()).toHaveLength(1)
    expect(stored()).toEqual([thumbs(2, true)])
  })

  test("takes any 2xx answer as done", async () => {
    f.discord.route("PUT", reactionPath("👍", "/@me"), { status: 200, json: {} })
    expect(await f.react(args())).toMatchObject({ emoji: "👍" })
    expect(f.readBacks()).toHaveLength(0)
  })

  test("a custom emoji the message holds goes by its stored name:id, in any spelling", async () => {
    f.setReactions(OWN, [{ emoji: PARTY, count: 1, me: false }])
    f.discord.route("PUT", reactionPath(PARTY, "/@me"), { status: 204 })
    expect(await f.react(args({ emoji: `<a:party:${msgId(50)}>` }))).toMatchObject({ emoji: PARTY })
    expect(f.writes()[0]!.path).toContain("party%3A")
    expect(stored()).toEqual([{ emoji: PARTY, count: 2, me: true }])
  })

  test("is reported as done even when the mirror cannot store it", async () => {
    f.discord.route("PUT", reactionPath("👍", "/@me"), () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'full'); END"))
      return { status: 204 }
    })
    const result = await f.react(args())
    expect(result.errors).toEqual({ store: expect.stringContaining("full") })
    expect(result.note).toContain("could not store")
    expect(stored()).toEqual([thumbs(2, false)])
    expect(f.readBacks()).toHaveLength(0)
  })
})

describe("taking back a reaction", () => {
  test("deletes the emoji once, with no query, and takes the account out of the count", async () => {
    f.setReactions(OWN, [thumbs(2, true)])
    f.discord.route("DELETE", reactionPath("👍", "/0/@me"), { status: 204 })
    expect(await f.unreact(args())).toEqual({
      id: OWN,
      channel: CHANNEL,
      emoji: "👍",
      note: expect.stringContaining("removed on Discord"),
    })
    const [request, ...rest] = f.writes()
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: reactionPath("👍", "/0/@me") })
    expect([...request!.query.keys()]).toEqual([])
    expect(stored()).toEqual([thumbs(1, false)])
    expect(f.readBacks()).toHaveLength(0)
  })

  test("works on someone else's message and drops the entry the account was alone in", async () => {
    f.setReactions(THEIRS, [thumbs(1, true), { emoji: "🎉", count: 1, me: false }])
    f.discord.route("DELETE", reactionPath("👍", "/0/@me", THEIRS), { status: 204 })
    await f.unreact(args({ message: THEIRS }))
    expect(stored(THEIRS)).toEqual([{ emoji: "🎉", count: 1, me: false }])
  })

  test("stores no reactions when the last one is taken back", async () => {
    f.setReactions(OWN, [thumbs(1, true)])
    f.discord.route("DELETE", reactionPath("👍", "/0/@me"), { status: 204 })
    await f.unreact(args())
    expect(f.row()!.reactions).toBeNull()
  })

  test("is sent when the mirror knows no reactions of the message", async () => {
    f.discord.route("DELETE", reactionPath("👍", "/0/@me", THEIRS), { status: 204 })
    await f.unreact(args({ message: THEIRS }))
    expect(f.writes()).toHaveLength(1)
    expect(f.row(THEIRS)!.reactions).toBeNull()
  })

  test("is refused without a request when the mirror shows the account never reacted", async () => {
    const before = f.row()!.reactions
    for (const emoji of ["👍", "🎉"]) {
      const error = await failure(f.unreact(args({ emoji })))
      expect(error).toMatchObject({
        code: "not_found",
        message: expect.stringContaining(`reaction ${emoji} by the account`),
      })
    }
    expect(f.discord.api).toHaveLength(0)
    expect(f.row()!.reactions).toBe(before)
  })

  test("a custom emoji goes by its stored name:id", async () => {
    f.setReactions(OWN, [{ emoji: PARTY, count: 3, me: true }])
    f.discord.route("DELETE", reactionPath(PARTY, "/0/@me"), { status: 204 })
    await f.unreact(args({ emoji: `<:party:${msgId(50)}>` }))
    expect(stored()).toEqual([{ emoji: PARTY, count: 2, me: false }])
  })
})

describe("a reaction that is refused before anything leaves", () => {
  const refused = async (call: typeof f.react, input: unknown, code: string) => {
    expect(await failure(call(input))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(0)
  }
  const targets = REFUSED_TARGETS.filter(([, , code]) => code !== "forbidden")

  test.each(targets)("adding on %s", (_, target, code) => refused(f.react, { ...target, emoji: "👍" }, code))
  test.each(targets)("removing on %s", (_, target, code) => refused(f.unreact, { ...target, emoji: "👍" }, code))

  test.each([
    ["an emoji of nothing", { emoji: "" }],
    ["a shortcode", { emoji: ":thumbsup:" }],
    ["two emoji", { emoji: "👍👍" }],
    ["text", { emoji: "ok" }],
    ["a custom emoji that is not on the message", { emoji: `party:${msgId(50)}` }],
    ["a missing emoji", { emoji: undefined }],
    ["an unknown argument", { super: true }],
  ])("%s is invalid_argument", async (_, extra) => {
    await refused(f.react, args(extra), "invalid_argument")
    await refused(f.unreact, args(extra), "invalid_argument")
  })

  test("a custom emoji that is not on the message says how to see its reactions", async () => {
    expect((await failure(f.react(args({ emoji: `party:${msgId(50)}` })))).message).toContain("discord_chat_read")
  })
})

describe("a reaction that Discord refuses", () => {
  test.each([
    [403, "forbidden", 50013],
    [400, "invalid_argument", 10014],
    [404, "not_found", 10008],
    [429, "rate_limited", 0],
  ])("a %i is %s, changes nothing and reads nothing back", async (status, code, discordCode) => {
    f.setReactions(OWN, [thumbs(2, true)])
    f.discord.route("PUT", reactionPath("👍", "/@me"), {
      status,
      json: { code: discordCode, retry_after: 1.5, message: "no" },
    })
    expect(await failure(f.react(args()))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(1)
    expect(stored()).toEqual([thumbs(2, true)])
  })

  test("a taking back that Discord refuses changes nothing either", async () => {
    f.setReactions(OWN, [thumbs(2, true)])
    f.discord.route("DELETE", reactionPath("👍", "/0/@me"), { status: 400, json: { code: 10014, message: "no" } })
    expect(await failure(f.unreact(args()))).toMatchObject({ code: "invalid_argument" })
    expect(f.discord.api).toHaveLength(1)
    expect(stored()).toEqual([thumbs(2, true)])
  })

  test.each([
    ["adding", () => f.react(args())],
    ["taking back", () => f.unreact(args({ message: THEIRS }))],
  ])("a connection never made while %s is upstream_error and reads nothing back", async (_, call) => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(call())).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("the tools' targets", () => {
  test("name the label and the channel", async () => {
    expect(await writeTargets(discordReactionAdd, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordReactionAdd, args({ account: "nobody" }), f.ctx)).toEqual(["*"])
  })
})
