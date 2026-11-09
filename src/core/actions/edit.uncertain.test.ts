import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, ME, messageObject, msgId, OTHER_CHANNEL } from "../discord/objects.testing"
import { discordMessageEdit } from "./edit-tool"
import { type ActionsFixture, createActionsFixture, editedMessage, messagePath, OWN, OWN_TEXT } from "./actions.testing"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const edit = () => failure(f.edit({ channel: CHANNEL, message: OWN, text: "new text" }))

describe("an edit whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and the read-back that saw the new text says applied", async () => {
    f.discord.route("PATCH", messagePath(), { status: 500, json: { message: "oops" } })
    f.serveAround([editedMessage("new text")])
    expect(await edit()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { applied: true, read_back: "done" },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
    expect(f.readBacks()[0]!.query.get("around")).toBe(OWN)
    expect(f.readBacks()[0]!.query.get("limit")).toBe("5")
    expect(f.row()!.content).toBe("new text")
  })

  test("a read-back that still saw the old text says not applied", async () => {
    f.discord.route("PATCH", messagePath(), { status: 502, json: {} })
    f.serveAround([messageObject(OWN, CHANNEL, { author: { id: ME }, content: OWN_TEXT })])
    expect(await edit()).toMatchObject({ details: { applied: false, read_back: "done" } })
    expect(f.row()!.content).toBe(OWN_TEXT)
  })

  test("a read-back without the message says not applied and deletes nothing", async () => {
    f.discord.route("PATCH", messagePath(), { status: 502, json: {} })
    f.serveAround([])
    expect(await edit()).toMatchObject({ details: { applied: false, read_back: "done" } })
    expect(f.row()!.content).toBe(OWN_TEXT)
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.serveAround([])
    expect(await edit()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
  })

  test.each([
    ["an answer without a message", { status: 200, json: {} }],
    ["an answer that is not JSON", { status: 200, text: "<html>" }],
    ["another message", { status: 200, json: editedMessage("new text", { id: msgId(11) }) }],
    ["another channel's message", { status: 200, json: editedMessage("new text", { channel_id: OTHER_CHANNEL }) }],
    ["another author's message", { status: 200, json: editedMessage("new text", { author: { id: "1" } }) }],
  ])("%s is uncertain, never a success", async (_, answer) => {
    f.discord.route("PATCH", messagePath(), answer)
    f.serveAround([editedMessage("new text")])
    expect(await edit()).toMatchObject({ code: "uncertain", details: { applied: true, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a failing read-back is reported as failed, with nothing known", async () => {
    f.discord.route("PATCH", messagePath(), { status: 502, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 500, json: {} })
    expect(await edit()).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "failed" } })
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a read-back that is not a list stores nothing and knows nothing", async () => {
    f.discord.route("PATCH", messagePath(), { status: 500, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: { message: "odd" } })
    expect(await edit()).toMatchObject({ details: { applied: null, read_back: "done" } })
    expect(f.row()!.content).toBe(OWN_TEXT)
  })

  test("a read-back that cannot be stored still says what it saw", async () => {
    f.discord.route("PATCH", messagePath(), { status: 500, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'full'); END"))
      return { status: 200, json: [editedMessage("new text")] }
    })
    expect(await edit()).toMatchObject({ details: { applied: true, read_back: "done" } })
    expect(f.row()!.content).toBe(OWN_TEXT)
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("PATCH", messagePath(), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordMessageEdit
      .execute({ channel: CHANNEL, message: OWN, text: "new text" }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "skipped" } })
    expect(f.readBacks()).toHaveLength(0)
  })
})
