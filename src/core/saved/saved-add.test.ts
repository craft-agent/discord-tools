import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OWN, REFUSED_TARGETS, THEIRS } from "../actions/actions.testing"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, DM, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { savedPath } from "./entries"
import { discordSavedAdd } from "./saved-tool"
import { createSavedFixture, type SavedFixture } from "./saved.testing"

let f: SavedFixture

beforeEach(async () => {
  f = await createSavedFixture()
})

afterEach(() => f.dispose())

const HOUR = 3_600_000
const PATH = savedPath(CHANNEL, OWN)
const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, message: OWN, ...extra })
const saved = (at: string, due: string | null) => ({ status: 200, json: { save_data: { saved_at: at, due_at: due } } })

describe("saving a message", () => {
  test("puts the save once, with no reminder asked for, and sends nothing else", async () => {
    f.discord.route("PUT", PATH, saved("2027-01-15T07:00:00.000000+00:00", null))
    expect(await f.save(args())).toEqual({
      channel: CHANNEL,
      message: OWN,
      saved_at: "2027-01-15T07:00:00.000Z",
      remind_at: null,
      note: expect.stringContaining("saved on Discord"),
    })
    const [request, ...rest] = f.discord.api
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PUT", path: PATH })
    expect([...request!.query.keys()]).toEqual([])
    expect(JSON.parse(request!.body!)).toEqual({ due_at: null })
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
  })

  test("asks for a reminder in UTC, whatever zone the time was given in", async () => {
    const due = new Date(f.now() + 2 * HOUR)
    const inJapan = new Date(due.getTime() + 9 * HOUR).toISOString().replace("Z", "+09:00")
    f.discord.route("PUT", PATH, saved("2027-01-15T07:00:00+00:00", due.toISOString().replace("Z", "+00:00")))
    const result = await f.save(args({ remind_at: inJapan }))
    expect(JSON.parse(f.discord.api[0]!.body!)).toEqual({ due_at: due.toISOString() })
    expect(result.remind_at).toBe(due.toISOString())
  })

  test("takes a reminder given in UTC as it is, in lower case too", async () => {
    const due = new Date(f.now() + HOUR).toISOString()
    f.discord.route("PUT", PATH, { status: 200, json: {} })
    await f.save(args({ remind_at: due }))
    await f.save(args({ remind_at: due.toLowerCase() }))
    expect(f.writes().map((request) => JSON.parse(request.body!))).toEqual([{ due_at: due }, { due_at: due }])
  })

  test("saves again without a reminder to replace one, so the request carries a null", async () => {
    f.discord.route("PUT", PATH, saved("2027-01-15T07:00:00Z", null))
    const due = new Date(f.now() + HOUR).toISOString()
    await f.save(args({ remind_at: due }))
    await f.save(args())
    expect(f.writes().map((request) => JSON.parse(request.body!).due_at)).toEqual([due, null])
  })

  test("works on someone else's message", async () => {
    f.discord.route("PUT", savedPath(CHANNEL, THEIRS), { status: 200, json: {} })
    expect(await f.save(args({ message: THEIRS }))).toMatchObject({ message: THEIRS })
  })

  test("answers null for what Discord's answer does not say, whatever it answers", async () => {
    for (const answer of [{ status: 204 }, { status: 200, json: {} }, { status: 200, json: { save_data: "x" } }]) {
      f.discord.route("PUT", PATH, answer)
      expect(await f.save(args())).toMatchObject({ saved_at: null, remind_at: null })
    }
    f.discord.route("PUT", PATH, saved("never", "soon"))
    expect(await f.save(args())).toMatchObject({ saved_at: null, remind_at: null })
  })

  test("leaves the mirror as it was", async () => {
    const before = f.inspect((m) => m.prepare("SELECT count(*) AS n FROM messages").get())
    f.discord.route("PUT", PATH, saved("2027-01-15T07:00:00Z", null))
    await f.save(args())
    expect(f.inspect((m) => m.prepare("SELECT count(*) AS n FROM messages").get())).toEqual(before)
    expect(f.row()).toBeDefined()
  })
})

describe("a save that is refused before anything leaves", () => {
  const refused = async (input: unknown, code: string, message?: string) => {
    const error = await failure(f.save(input))
    expect(error).toMatchObject({ code, ...(message ? { message: expect.stringContaining(message) } : {}) })
    expect(f.discord.api).toHaveLength(0)
  }
  const targets = REFUSED_TARGETS.filter(([, , code]) => code !== "forbidden")

  test.each(targets)("on %s", (_, target, code) => refused(target, code))

  test.each(["tomorrow", "", "2027-01-16", "2027-01-15T10:00:00", "2027-02-30T10:00:00Z", "2027-01-15 10:00:00Z"])(
    "a reminder of %p is not a timestamp with a zone",
    (remind_at) => refused(args({ remind_at }), "invalid_argument", "`remind_at` must be a timestamp with a zone"),
  )

  test("a reminder that is not later than now", async () => {
    for (const at of [f.now() - HOUR, f.now()]) {
      await refused(args({ remind_at: new Date(at).toISOString() }), "invalid_argument", "later than now")
    }
  })

  test("a reminder is checked before the mirror is asked about the message", async () => {
    await refused({ channel: CHANNEL, message: "1400000000000000999", remind_at: "tomorrow" }, "invalid_argument")
  })

  test("an unknown argument", () => refused(args({ super: true }), "invalid_argument"))
})

describe("a save that Discord refuses", () => {
  test.each([
    [400, "invalid_argument", 30003],
    [403, "forbidden", 50013],
    [404, "not_found", 10008],
    [429, "rate_limited", 0],
  ])("a %i is %s and reads nothing back", async (status, code, discordCode) => {
    f.discord.route("PUT", PATH, { status, json: { code: discordCode, retry_after: 1.5, message: "no" } })
    const error = await failure(f.save(args()))
    expect(error).toMatchObject({ code })
    if (discordCode > 0) expect(error).toMatchObject({ details: { discord_code: discordCode } })
    expect(f.discord.api).toHaveLength(1)
  })

  test("a connection never made is upstream_error and reads nothing back", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(f.save(args()))).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("the tool's targets", () => {
  test("name the label and the channel", async () => {
    expect(await writeTargets(discordSavedAdd, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordSavedAdd, args({ account: "nobody" }), f.ctx)).toEqual(["*"])
  })

  test("is an overwrite in the inbox toolset, with an intent", () => {
    expect(discordSavedAdd).toMatchObject({ toolset: "inbox", class: "overwrite", intent: expect.any(String) })
    expect(discordSavedAdd.description).toContain("replaces its reminder")
  })
})
