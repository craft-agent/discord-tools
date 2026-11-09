import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, ME, messageObject } from "../discord/objects.testing"
import { discordMessageDelete } from "./delete-tool"
import { type ActionsFixture, createActionsFixture, messagePath, OWN, OWN_TEXT, THEIRS } from "./actions.testing"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const remove = () => failure(f.remove({ channel: CHANNEL, message: OWN }))

/** What a read-back around the message sees when it is still there. */
const stillThere = () => messageObject(OWN, CHANNEL, { author: { id: ME }, content: OWN_TEXT })

describe("a delete whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and a read-back without the message says applied", async () => {
    f.discord.route("DELETE", messagePath(), { status: 500, json: { message: "oops" } })
    f.serveAround([messageObject(THEIRS, CHANNEL)])
    expect(await remove()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { applied: true, read_back: "done" },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
    expect(f.readBacks()[0]!.query.get("around")).toBe(OWN)
    expect(f.readBacks()[0]!.query.get("limit")).toBe("5")
  })

  test("the mirror keeps the row: an absent message in a read-back is only a hint", async () => {
    f.discord.route("DELETE", messagePath(), { status: 500, json: {} })
    f.serveAround([])
    await remove()
    expect(f.row()).toBeDefined()
  })

  test("a read-back that still saw the message says not applied", async () => {
    f.discord.route("DELETE", messagePath(), { status: 502, json: {} })
    f.serveAround([stillThere()])
    expect(await remove()).toMatchObject({ details: { applied: false, read_back: "done" } })
    expect(f.row()).toBeDefined()
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.serveAround([stillThere()])
    expect(await remove()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
  })

  test("a failing read-back is reported as failed, with nothing known", async () => {
    f.discord.route("DELETE", messagePath(), { status: 502, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 500, json: {} })
    expect(await remove()).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "failed" } })
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a read-back that is not a list knows nothing", async () => {
    f.discord.route("DELETE", messagePath(), { status: 500, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: { message: "odd" } })
    expect(await remove()).toMatchObject({ details: { applied: null, read_back: "done" } })
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("DELETE", messagePath(), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordMessageDelete
      .execute({ channel: CHANNEL, message: OWN }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "skipped" } })
    expect(f.readBacks()).toHaveLength(0)
    expect(f.row()).toBeDefined()
  })
})
