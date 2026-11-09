import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, ME, messageObject, msgId } from "../discord/objects.testing"
import { type ActionsFixture, createActionsFixture, OWN, pinPath } from "./actions.testing"
import { discordPinAdd } from "./pin-tool"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const args = { channel: CHANNEL, message: OWN }
const PATH = pinPath()

/** The own message as a read-back shows it, pinned or not. */
const readBack = (pinned: boolean) => messageObject(OWN, CHANNEL, { author: { id: ME }, pinned })

const pin = () => failure(f.pin(args))
const unpin = () => failure(f.unpin(args))

describe("pinning a message whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and a read-back that saw it pinned says applied", async () => {
    f.discord.route("PUT", PATH, { status: 500, json: { message: "oops" } })
    f.serveAround([readBack(true)])
    expect(await pin()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { applied: true, read_back: "done" },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
    expect(f.readBacks()[0]!.query.get("around")).toBe(OWN)
    expect(f.isPinned()).toBe(true)
  })

  test.each([
    ["the message not pinned", [readBack(false)]],
    ["no message", []],
  ])("a read-back with %s says not applied", async (_, seen) => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.serveAround(seen)
    expect(await pin()).toMatchObject({ details: { applied: false, read_back: "done" } })
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.serveAround([])
    expect(await pin()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
  })

  test("an answer that is not JSON is uncertain, never a success", async () => {
    f.discord.route("PUT", PATH, { status: 200, text: "<html>" })
    f.serveAround([readBack(true)])
    expect(await pin()).toMatchObject({ code: "uncertain", details: { applied: true } })
    expect(f.writes()).toHaveLength(1)
  })

  test("a failing read-back is reported as failed, with nothing known", async () => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 500, json: {} })
    expect(await pin()).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "failed" } })
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("PUT", PATH, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordPinAdd.execute(args, { ...f.ctx, signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "skipped" } })
    expect(f.readBacks()).toHaveLength(0)
  })
})

describe("unpinning a message whose outcome is unknown", () => {
  beforeEach(() => f.setPinnedRow(OWN, true))

  test.each([
    ["the message not pinned", [readBack(false)], true],
    ["the message still pinned", [readBack(true)], false],
    ["no message", [], false],
  ])("a read-back with %s says applied: %p", async (_, seen, applied) => {
    f.discord.route("DELETE", PATH, { status: 500, json: {} })
    f.serveAround(seen)
    expect(await unpin()).toMatchObject({ code: "uncertain", details: { applied, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a failing read-back knows nothing", async () => {
    f.discord.route("DELETE", PATH, { status: 502, json: {} })
    f.discord.route("GET", `/channels/${CHANNEL}/messages`, { status: 500, json: {} })
    expect(await unpin()).toMatchObject({ details: { applied: null, read_back: "failed" } })
  })
})

describe("the read-back's message", () => {
  test("is matched by id, so another message's pin does not count", async () => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.serveAround([{ ...readBack(true), id: msgId(11) }])
    expect(await pin()).toMatchObject({ details: { applied: false } })
  })
})
