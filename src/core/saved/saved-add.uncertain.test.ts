import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OWN } from "../actions/actions.testing"
import { failure } from "../chats/read.testing"
import { CHANNEL, messageObject, msgId } from "../discord/objects.testing"
import { SAVED_PATH, savedPath } from "./entries"
import { discordSavedAdd } from "./saved-tool"
import { createSavedFixture, saveEntry, savedList, type SavedFixture } from "./saved.testing"

let f: SavedFixture

beforeEach(async () => {
  f = await createSavedFixture()
})

afterEach(() => f.dispose())

const PATH = savedPath(CHANNEL, OWN)
const DUE = "2030-01-01T00:00:00.000Z"
const save = (extra: Record<string, unknown> = {}) => failure(f.save({ channel: CHANNEL, message: OWN, ...extra }))

/** The entry of `OWN` (`msgId(10)`) as the list shows it, with a reminder or without. */
const entryOfOwn = (dueAt: string | null) => saveEntry(CHANNEL, 10, { dueAt })

describe("a save whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and a list that holds the save says applied", async () => {
    f.discord.route("PUT", PATH, { status: 500, json: { message: "oops" } })
    f.discord.route("GET", SAVED_PATH, savedList(entryOfOwn(null)))
    expect(await save()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { applied: true, read_back: "done" },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.listReads()).toHaveLength(1)
    expect([...f.listReads()[0]!.query.keys()]).toEqual([])
  })

  test.each([
    ["no entry", []],
    ["only another message's entry", [saveEntry(CHANNEL, 11)]],
  ])("a list with %s says not applied", async (_, results) => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.discord.route("GET", SAVED_PATH, savedList(...results))
    expect(await save()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
  })

  test("a reminder asked for is applied only when the entry has that time", async () => {
    f.discord.route("PUT", PATH, { status: 500, json: {} })
    f.discord.route("GET", SAVED_PATH, savedList(entryOfOwn(DUE)))
    expect(await save({ remind_at: "2030-01-01T09:00:00+09:00" })).toMatchObject({ details: { applied: true } })
    expect(await save({ remind_at: "2031-01-01T00:00:00Z" })).toMatchObject({ details: { applied: false } })
    expect(await save()).toMatchObject({ details: { applied: false } })
    f.discord.route("GET", SAVED_PATH, savedList(entryOfOwn(null)))
    expect(await save({ remind_at: DUE })).toMatchObject({ details: { applied: false } })
  })

  test("a read-back that finds no list at all says not applied", async () => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.discord.route("GET", SAVED_PATH, { status: 404, json: { code: 10133, message: "Unknown Saved Messages" } })
    expect(await save()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.discord.route("GET", SAVED_PATH, savedList())
    expect(await save()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
  })

  test("an answer that is not JSON is uncertain, never a success", async () => {
    f.discord.route("PUT", PATH, { status: 200, text: "<html>" })
    f.discord.route("GET", SAVED_PATH, savedList(entryOfOwn(null)))
    expect(await save()).toMatchObject({ code: "uncertain", details: { applied: true } })
    expect(f.writes()).toHaveLength(1)
  })

  test("a list that is not a list knows nothing", async () => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.discord.route("GET", SAVED_PATH, { status: 200, json: [] })
    expect(await save()).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "done" } })
  })

  test("a failing read-back is reported as failed, with nothing known", async () => {
    f.discord.route("PUT", PATH, { status: 502, json: {} })
    f.discord.route("GET", SAVED_PATH, { status: 500, json: {} })
    expect(await save()).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "failed" } })
    expect(f.listReads()).toHaveLength(1)
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("PUT", PATH, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordSavedAdd
      .execute({ channel: CHANNEL, message: OWN }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "skipped" } })
    expect(f.listReads()).toHaveLength(0)
  })

  test("stores nothing from the read-back", async () => {
    const before = f.inspect((m) => m.prepare("SELECT count(*) AS n FROM messages").get())
    f.discord.route("PUT", PATH, { status: 500, json: {} })
    f.discord.route("GET", SAVED_PATH, savedList(saveEntry(CHANNEL, 77, {}, messageObject(msgId(77), CHANNEL))))
    await save()
    expect(f.inspect((m) => m.prepare("SELECT count(*) AS n FROM messages").get())).toEqual(before)
  })
})
