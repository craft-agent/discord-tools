import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OWN, REFUSED_TARGETS, THEIRS } from "../actions/actions.testing"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, DM, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { SAVED_PATH, savedPath } from "./entries"
import { discordSavedRemove } from "./saved-tool"
import { createSavedFixture, saveEntry, savedList, type SavedFixture } from "./saved.testing"

let f: SavedFixture

beforeEach(async () => {
  f = await createSavedFixture()
})

afterEach(() => f.dispose())

const PATH = savedPath(CHANNEL, OWN)
const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, message: OWN, ...extra })
const remove = () => failure(f.unsave(args()))

describe("removing a save", () => {
  test("deletes the save once, with no body, and sends nothing else", async () => {
    f.discord.route("DELETE", PATH, { status: 204 })
    expect(await f.unsave(args())).toEqual({
      channel: CHANNEL,
      message: OWN,
      already: false,
      note: expect.stringContaining("no longer saved"),
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: PATH })
    expect([...request!.query.keys()]).toEqual([])
    expect(request!.body).toBeUndefined()
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
  })

  test("takes any 2xx answer as done, and works on someone else's message", async () => {
    f.discord.route("DELETE", savedPath(CHANNEL, THEIRS), { status: 200, json: {} })
    expect(await f.unsave(args({ message: THEIRS }))).toMatchObject({ message: THEIRS, already: false })
  })

  test("a message that is not saved (a 404) is done, marked already", async () => {
    f.discord.route("DELETE", PATH, { status: 404, json: { code: 10008, message: "Unknown" } })
    expect(await f.unsave(args())).toEqual({
      channel: CHANNEL,
      message: OWN,
      already: true,
      note: expect.stringContaining("did not have the message saved"),
    })
    expect(f.discord.api).toHaveLength(1)
  })

  test("a 404 without a code is already too, and not sent again", async () => {
    f.discord.route("DELETE", PATH, { status: 404, json: {} })
    expect(await f.unsave(args())).toMatchObject({ already: true })
    expect(f.discord.api).toHaveLength(1)
  })

  test("leaves the mirror as it was", async () => {
    f.discord.route("DELETE", PATH, { status: 204 })
    await f.unsave(args())
    expect(f.row()).toBeDefined()
  })
})

describe("a removal that is refused before anything leaves", () => {
  const refused = async (input: unknown, code: string) => {
    expect(await failure(f.unsave(input))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(0)
  }

  test.each(REFUSED_TARGETS.filter(([, , code]) => code !== "forbidden"))("on %s", (_, target, code) =>
    refused(target, code),
  )

  test("an unknown argument", () => refused(args({ remind_at: "2030-01-01T00:00:00Z" }), "invalid_argument"))
})

describe("a removal that Discord refuses", () => {
  test.each([
    [400, "invalid_argument"],
    [403, "forbidden"],
    [429, "rate_limited"],
  ])("a %i is %s and reads nothing back", async (status, code) => {
    f.discord.route("DELETE", PATH, { status, json: { code: 0, retry_after: 1.5, message: "no" } })
    expect(await remove()).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(1)
  })

  test("a connection never made is upstream_error", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await remove()).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("a removal whose outcome is unknown", () => {
  test.each([
    ["no entry for the message", [], true],
    ["an entry for another message only", [saveEntry(CHANNEL, 11)], true],
    ["the message still saved", [saveEntry(CHANNEL, 10)], false],
  ])("a server error with a list with %s says applied: %p", async (_, results, applied) => {
    f.discord.route("DELETE", PATH, { status: 500, json: { message: "oops" } })
    f.discord.route("GET", SAVED_PATH, savedList(...results))
    expect(await remove()).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { applied, read_back: "done" },
    })
    expect(f.writes()).toHaveLength(1)
    expect(f.listReads()).toHaveLength(1)
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.discord.route("GET", SAVED_PATH, savedList(saveEntry(CHANNEL, 10)))
    expect(await remove()).toMatchObject({ code: "uncertain", details: { applied: false, read_back: "done" } })
    expect(f.writes()).toHaveLength(1)
  })

  test("a list that is not a list knows nothing, and a failing read-back is failed", async () => {
    f.discord.route("DELETE", PATH, { status: 502, json: {} })
    f.discord.route("GET", SAVED_PATH, { status: 200, json: [] })
    expect(await remove()).toMatchObject({ details: { applied: null, read_back: "done" } })
    f.discord.route("GET", SAVED_PATH, { status: 500, json: {} })
    expect(await remove()).toMatchObject({ details: { applied: null, read_back: "failed" } })
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("DELETE", PATH, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordSavedRemove.execute(args(), { ...f.ctx, signal: controller.signal }).catch((e) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { applied: null, read_back: "skipped" } })
    expect(f.listReads()).toHaveLength(0)
  })
})

describe("the tool", () => {
  test("names the label and the channel as its target", async () => {
    expect(await writeTargets(discordSavedRemove, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
  })

  test("is an overwrite in the inbox toolset, with an intent", () => {
    expect(discordSavedRemove).toMatchObject({ toolset: "inbox", class: "overwrite", intent: expect.any(String) })
    expect(discordSavedRemove.description).toContain("`already`")
  })
})
