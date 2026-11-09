import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { getCursor } from "../discord/mirror-cursors"
import { CHANNEL, DM, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { discordMessageEdit } from "./edit-tool"
import {
  type ActionsFixture,
  createActionsFixture,
  EDITED_AT,
  editedMessage,
  messagePath,
  OWN,
  OWN_TEXT,
  REFUSED_TARGETS,
} from "./actions.testing"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, message: OWN, text: "new text", ...extra })

describe("an edit", () => {
  test("patches the text once and returns what Discord says", async () => {
    f.discord.route("PATCH", messagePath(), { status: 200, json: editedMessage("new text") })
    const result = await f.edit(args())
    expect(result).toEqual({
      id: OWN,
      channel: CHANNEL,
      edited_at: EDITED_AT,
      note: expect.stringContaining("edited on Discord"),
    })
    const [request, ...rest] = f.writes()
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PATCH", path: messagePath() })
    expect(JSON.parse(request!.body!)).toEqual({
      content: "new text",
      allowed_mentions: { parse: ["users"], replied_user: false },
    })
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
    expect(f.readBacks()).toHaveLength(0)
  })

  test("sends the text as given and lets mass mentions notify only when asked", async () => {
    f.discord.route("PATCH", messagePath(), { status: 200, json: editedMessage(" @here \n") })
    await f.edit(args({ text: " @here \n", mass_mentions: true }))
    expect(JSON.parse(f.writes()[0]!.body!)).toEqual({
      content: " @here \n",
      allowed_mentions: { parse: ["users", "roles", "everyone"], replied_user: false },
    })
  })

  test("stores the new text and time but keeps the stored reactions and the channel's cursor", async () => {
    const before = f.row()
    const cursor = f.inspect((m) => getCursor(m, CHANNEL))
    expect(before).toMatchObject({ content: OWN_TEXT, edited_at: null, from_me: 1 })
    expect(before!.reactions).not.toBeNull()
    f.discord.route("PATCH", messagePath(), { status: 200, json: editedMessage("new text") })
    await f.edit(args())
    expect(f.row()).toEqual({
      content: "new text",
      edited_at: Date.parse(EDITED_AT),
      reactions: before!.reactions,
      from_me: 1,
    })
    expect(f.inspect((m) => getCursor(m, CHANNEL))).toEqual(cursor)
  })

  test("reports a null edit time when Discord answers without one", async () => {
    f.discord.route("PATCH", messagePath(), {
      status: 200,
      json: editedMessage("new text", { edited_timestamp: null }),
    })
    expect(await f.edit(args())).toMatchObject({ edited_at: null })
  })

  test("is reported as done even when the mirror cannot store it", async () => {
    f.discord.route("PATCH", messagePath(), () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'full'); END"))
      return { status: 200, json: editedMessage("new text") }
    })
    const result = await f.edit(args())
    expect(result.errors).toEqual({ store: expect.stringContaining("full") })
    expect(result.note).toContain("could not store")
    expect(f.readBacks()).toHaveLength(0)
    expect(f.row()!.content).toBe(OWN_TEXT)
  })
})

describe("an edit that is refused before anything leaves", () => {
  const refused = async (input: unknown, code: string) => {
    expect(await failure(f.edit(input))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(0)
    expect(f.row()!.content).toBe(OWN_TEXT)
  }

  test.each(REFUSED_TARGETS)("%s", (_, target, code) => refused({ ...target, text: "new text" }, code))

  test("an unknown message says to read the chat first", async () => {
    const error = await failure(f.edit({ ...REFUSED_TARGETS[1]![1], text: "new text" }))
    expect(error.message).toContain("discord_chat_read")
  })

  test("someone else's message says only the account's own can be edited", async () => {
    const error = await failure(f.edit({ ...REFUSED_TARGETS[3]![1], text: "new text" }))
    expect(error.message).toContain("Only the account's own messages")
  })

  test("a text the mirror already holds is invalid_argument", () =>
    refused(args({ text: OWN_TEXT }), "invalid_argument"))

  test.each([
    ["text of whitespace only", { text: " \n\t " }],
    ["empty text", { text: "" }],
    ["text over 4000 characters", { text: "x".repeat(4001) }],
    ["a missing message", { message: undefined }],
    ["an unknown argument", { tts: true }],
  ])("%s is invalid_argument", (_, extra) => refused(args(extra), "invalid_argument"))
})

describe("an edit that Discord refuses", () => {
  test.each([
    [400, "invalid_argument"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ])("a %i is %s, changes nothing and reads nothing back", async (status, code) => {
    f.discord.route("PATCH", messagePath(), { status, json: { code: 50013, retry_after: 1.5, message: "no" } })
    expect(await failure(f.edit(args()))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(1)
    expect(f.row()!.content).toBe(OWN_TEXT)
  })

  test("a connection never made is upstream_error and reads nothing back", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(f.edit(args()))).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("the tool's targets", () => {
  test("name the label and the channel", async () => {
    expect(await writeTargets(discordMessageEdit, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordMessageEdit, args({ account: "nobody" }), f.ctx)).toEqual(["*"])
  })
})
