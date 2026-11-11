import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ELSEWHERE, OWN, THEIRS } from "../actions/actions.testing"
import { CATEGORY, FORUM } from "../chats/read.messages.testing"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, DM, msgId, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { discordReadMark } from "./read-mark-tool"
import { ackPath, createReadMarkFixture, EMPTY_CHANNEL, NEWEST, type ReadMarkFixture } from "./read-mark.testing"

let f: ReadMarkFixture

beforeEach(async () => {
  f = await createReadMarkFixture()
})

afterEach(() => f.dispose())

const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, ...extra })
const accepted = { status: 200, json: { token: null } }

describe("marking a chat read", () => {
  test("posts one ack for the newest mirrored message, with a null token and nothing else", async () => {
    f.discord.route("POST", ackPath(NEWEST), accepted)
    expect(await f.mark(args())).toEqual({
      channel: CHANNEL,
      message: NEWEST,
      chat: "#general",
      note: expect.stringContaining("marked read on Discord"),
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "POST", path: ackPath(NEWEST) })
    expect([...request!.query.keys()]).toEqual([])
    expect(JSON.parse(request!.body!)).toEqual({ token: null })
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
  })

  test("marks up to the message named, whoever wrote it, even when newer ones are mirrored", async () => {
    for (const message of [THEIRS, OWN]) {
      f.discord.route("POST", ackPath(message), accepted)
      expect(await f.mark(args({ message }))).toMatchObject({ channel: CHANNEL, message })
    }
    expect(f.writes().map((request) => request.path)).toEqual([ackPath(THEIRS), ackPath(OWN)])
  })

  test("never sends manual or a last-viewed time", async () => {
    f.discord.route("POST", ackPath(NEWEST), { status: 204 })
    await f.mark(args())
    expect(Object.keys(JSON.parse(f.discord.api[0]!.body!))).toEqual(["token"])
  })

  test("takes an empty or unexpected answer as marked", async () => {
    for (const answer of [{ status: 204 }, { status: 200, json: {} }, { status: 200, json: { token: "ignored" } }]) {
      f.discord.route("POST", ackPath(NEWEST), answer)
      expect(await f.mark(args())).toMatchObject({ message: NEWEST })
    }
  })

  test("stores nothing in the mirror", async () => {
    f.discord.route("POST", ackPath(NEWEST), accepted)
    const before = f.messageCount()
    await f.mark(args())
    expect(f.messageCount()).toBe(before)
    expect(f.row(NEWEST)).toBeDefined()
  })
})

describe("a mark that is refused before anything leaves", () => {
  const refused = async (input: unknown, code: string, message?: string) => {
    const error = await failure(f.mark(input))
    expect(error).toMatchObject({ code, ...(message ? { message: expect.stringContaining(message) } : {}) })
    expect(f.discord.api).toHaveLength(0)
  }

  test.each([
    ["an unknown channel", { channel: "1400000000000000999" }, "not_found"],
    ["an unknown channel with a message", { channel: "1400000000000000999", message: OWN }, "not_found"],
    ["an unknown message", args({ message: msgId(99) }), "not_found"],
    ["a message of another channel", args({ message: ELSEWHERE }), "not_found"],
    ["a category", { channel: CATEGORY }, "invalid_argument"],
    ["a forum", { channel: FORUM }, "invalid_argument"],
    ["a channel that is not an id", { channel: "general" }, "invalid_argument"],
    ["a message that is not an id", args({ message: "latest" }), "invalid_argument"],
    ["no channel", {}, "invalid_argument"],
    ["an unknown argument", args({ manual: true }), "invalid_argument"],
  ])("on %s", (_, input, code) => refused(input, code))

  test("a chat the mirror holds no message of says to read it first", async () => {
    await refused({ channel: EMPTY_CHANNEL }, "invalid_argument", "discord_chat_read")
  })
})

describe("a mark that Discord refuses", () => {
  test.each([
    [403, "forbidden", 50013],
    [404, "not_found", 10003],
    [429, "rate_limited", 0],
  ])("a %i is %s and is not retried", async (status, code, discordCode) => {
    f.discord.route("POST", ackPath(NEWEST), { status, json: { code: discordCode, retry_after: 1.5, message: "no" } })
    const error = await failure(f.mark(args()))
    expect(error).toMatchObject({ code })
    if (discordCode > 0) expect(error).toMatchObject({ details: { discord_code: discordCode } })
    expect(f.discord.api).toHaveLength(1)
    expect(f.sleeps).toEqual([])
  })

  test("a connection never made is upstream_error", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(f.mark(args()))).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("the tool's targets", () => {
  test("name the label and the channel, with or without a message", async () => {
    expect(await writeTargets(discordReadMark, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
    expect(await writeTargets(discordReadMark, args({ message: OWN }), f.ctx)).toEqual([`default/channel/${CHANNEL}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordReadMark, args({ account: "nobody" }), f.ctx)).toEqual(["*"])
  })

  test("is an overwrite in the inbox toolset, with an intent", () => {
    expect(discordReadMark).toMatchObject({ toolset: "inbox", class: "overwrite", intent: expect.any(String) })
    expect(discordReadMark.description).toContain("only when the person asks")
  })
})
