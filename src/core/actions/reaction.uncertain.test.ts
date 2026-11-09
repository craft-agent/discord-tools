import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, ME, messageObject, msgId } from "../discord/objects.testing"
import { type ActionsFixture, createActionsFixture, reactionPath, OWN } from "./actions.testing"
import { discordReactionAdd } from "./reaction-tool"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const args = { channel: CHANNEL, message: OWN, emoji: "👍" }
const ADD = reactionPath("👍", "/@me")
const REMOVE = reactionPath("👍", "/0/@me")

/** The own message as a read-back shows it, with the 👍 reaction in this state (`undefined`: no such reaction). */
const readBack = (me: boolean | undefined) =>
  messageObject(OWN, CHANNEL, {
    author: { id: ME },
    reactions: me === undefined ? [] : [{ emoji: { id: null, name: "👍" }, count: 2, me }],
  })

const add = () => failure(f.react(args))
const remove = () => failure(f.unreact(args))

describe("adding a reaction whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and a read-back that saw the reaction says applied", async () => {
    f.discord.route("PUT", ADD, { status: 500, json: { message: "oops" } })
    f.serveAround([readBack(true)])
    expect(await add()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { applied: true, read_back: "done" },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
    expect(f.readBacks()[0]!.query.get("around")).toBe(OWN)
    expect(JSON.parse(f.row()!.reactions!)).toEqual([{ emoji: "👍", count: 2, me: true }])
  })

  test.each([
    ["the reaction without the account", [readBack(false)]],
    ["no such reaction", [readBack(undefined)]],
    ["no message", []],
  ])("a read-back with %s says not applied", async (_, seen) => {
    f.discord.route("PUT", ADD, { status: 502, json: {} })
    f.serveAround(seen)
    expect(await add()).toMatchObject({ details: { applied: false, read_back: "done" } })
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.serveAround([])
    expect(await add()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
  })

  test("an answer that is not JSON is uncertain, never a success", async () => {
    f.discord.route("PUT", ADD, { status: 200, text: "<html>" })
    f.serveAround([readBack(true)])
    expect(await add()).toMatchObject({ code: "uncertain", details: { applied: true } })
    expect(f.writes()).toHaveLength(1)
  })

  test("a failing read-back is reported as failed, with nothing known", async () => {
    f.discord.route("PUT", ADD, { status: 502, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 500, json: {} })
    expect(await add()).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "failed" } })
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a read-back that is not a list knows nothing", async () => {
    f.discord.route("PUT", ADD, { status: 500, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 200, json: { message: "odd" } })
    expect(await add()).toMatchObject({ details: { applied: null, read_back: "done" } })
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("PUT", ADD, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordReactionAdd
      .execute(args, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "skipped" } })
    expect(f.readBacks()).toHaveLength(0)
  })
})

describe("taking back a reaction whose outcome is unknown", () => {
  beforeEach(() => f.setReactions(OWN, [{ emoji: "👍", count: 2, me: true }]))

  test.each([
    ["the reaction without the account", [readBack(false)], true],
    ["no such reaction", [readBack(undefined)], true],
    ["no message", [], false],
  ])("a read-back with %s says applied: %p", async (_, seen, applied) => {
    f.discord.route("DELETE", REMOVE, { status: 500, json: {} })
    f.serveAround(seen)
    expect(await remove()).toMatchObject({ code: "uncertain", details: { applied, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a read-back that still saw the reaction says not applied", async () => {
    f.discord.route("DELETE", REMOVE, { status: 502, json: {} })
    f.serveAround([readBack(true)])
    expect(await remove()).toMatchObject({ details: { applied: false, read_back: "done" } })
    expect(JSON.parse(f.row()!.reactions!)).toEqual([{ emoji: "👍", count: 2, me: true }])
  })

  test("a failing read-back knows nothing", async () => {
    f.discord.route("DELETE", REMOVE, { status: 502, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 500, json: {} })
    expect(await remove()).toMatchObject({ details: { applied: null, read_back: "failed" } })
  })
})

describe("the read-back's message", () => {
  test("is matched by id, so another message's reaction does not count", async () => {
    f.discord.route("PUT", ADD, { status: 502, json: {} })
    f.serveAround([{ ...readBack(true), id: msgId(11) }])
    expect(await add()).toMatchObject({ details: { applied: false } })
  })
})
