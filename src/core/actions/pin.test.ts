import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, DM, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import {
  type ActionsFixture,
  createActionsFixture,
  OWN,
  pinPath,
  REFUSED_TARGETS,
  SYSTEM,
  THEIRS,
} from "./actions.testing"
import { discordPinAdd } from "./pin-tool"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, message: OWN, ...extra })

describe("pinning a message", () => {
  test("puts the pin once, with no query and no body, and the mirror shows it", async () => {
    f.discord.route("PUT", pinPath(), { status: 204 })
    expect(await f.pin(args())).toEqual({
      id: OWN,
      channel: CHANNEL,
      pinned: true,
      note: expect.stringContaining("pinned on Discord"),
    })
    const [request, ...rest] = f.writes()
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "PUT", path: pinPath() })
    expect([...request!.query.keys()]).toEqual([])
    expect(request!.body ?? "").toBe("")
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
    expect(f.readBacks()).toHaveLength(0)
    expect(f.isPinned()).toBe(true)
  })

  test("works on someone else's message", async () => {
    f.discord.route("PUT", pinPath(THEIRS), { status: 204 })
    await f.pin(args({ message: THEIRS }))
    expect(f.isPinned(THEIRS)).toBe(true)
  })

  test("is sent even when the mirror shows it pinned, and changes nothing", async () => {
    f.setPinnedRow(OWN, true)
    f.discord.route("PUT", pinPath(), { status: 204 })
    await f.pin(args())
    expect(f.writes()).toHaveLength(1)
    expect(f.isPinned()).toBe(true)
  })

  test("takes any 2xx answer as done", async () => {
    f.discord.route("PUT", pinPath(), { status: 200, json: {} })
    expect(await f.pin(args())).toMatchObject({ pinned: true })
    expect(f.readBacks()).toHaveLength(0)
  })

  test("is reported as done even when the mirror cannot store it", async () => {
    f.discord.route("PUT", pinPath(), () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'full'); END"))
      return { status: 204 }
    })
    const result = await f.pin(args())
    expect(result.errors).toEqual({ store: expect.stringContaining("full") })
    expect(result.note).toContain("could not store")
    expect(f.isPinned()).toBe(false)
    expect(f.readBacks()).toHaveLength(0)
  })
})

describe("unpinning a message", () => {
  test("deletes the pin once, with no query, and the mirror no longer shows it", async () => {
    f.setPinnedRow(THEIRS, true)
    f.discord.route("DELETE", pinPath(THEIRS), { status: 204 })
    expect(await f.unpin(args({ message: THEIRS }))).toEqual({
      id: THEIRS,
      channel: CHANNEL,
      pinned: false,
      note: expect.stringContaining("unpinned on Discord"),
    })
    const [request, ...rest] = f.writes()
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: pinPath(THEIRS) })
    expect([...request!.query.keys()]).toEqual([])
    expect(request!.body ?? "").toBe("")
    expect(f.isPinned(THEIRS)).toBe(false)
    expect(f.readBacks()).toHaveLength(0)
  })

  test("is sent even when the mirror shows it unpinned", async () => {
    f.discord.route("DELETE", pinPath(), { status: 204 })
    await f.unpin(args())
    expect(f.writes()).toHaveLength(1)
    expect(f.isPinned()).toBe(false)
  })

  test("a system message can be unpinned", async () => {
    f.setPinnedRow(SYSTEM, true)
    f.discord.route("DELETE", pinPath(SYSTEM), { status: 204 })
    await f.unpin(args({ message: SYSTEM }))
    expect(f.isPinned(SYSTEM)).toBe(false)
  })
})

describe("a pin change that is refused before anything leaves", () => {
  const refused = async (call: typeof f.pin, input: unknown, code: string) => {
    expect(await failure(call(input))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(0)
  }
  const targets = REFUSED_TARGETS.filter(([, , code]) => code !== "forbidden")

  test.each(targets)("pinning on %s", (_, target, code) => refused(f.pin, target, code))
  test.each(targets)("unpinning on %s", (_, target, code) => refused(f.unpin, target, code))

  test("pinning a system message is invalid_argument", async () => {
    const error = await failure(f.pin(args({ message: SYSTEM })))
    expect(error).toMatchObject({ code: "invalid_argument", message: expect.stringContaining("system message") })
    expect(f.discord.api).toHaveLength(0)
    expect(f.isPinned(SYSTEM)).toBe(false)
  })

  test("an unknown argument is invalid_argument", async () => {
    await refused(f.pin, args({ super: true }), "invalid_argument")
    await refused(f.unpin, args({ super: true }), "invalid_argument")
  })
})

describe("a pin change that Discord refuses", () => {
  test.each([
    [403, "forbidden", 50013],
    [400, "invalid_argument", 30003],
    [404, "not_found", 10008],
    [429, "rate_limited", 0],
  ])("a %i is %s, changes nothing and reads nothing back", async (status, code, discordCode) => {
    f.discord.route("PUT", pinPath(), { status, json: { code: discordCode, retry_after: 1.5, message: "no" } })
    const error = await failure(f.pin(args()))
    expect(error).toMatchObject({ code })
    if (discordCode > 0) expect(error).toMatchObject({ details: { discord_code: discordCode } })
    expect(f.discord.api).toHaveLength(1)
    expect(f.isPinned()).toBe(false)
  })

  test("an unpin that Discord refuses changes nothing either", async () => {
    f.setPinnedRow(OWN, true)
    f.discord.route("DELETE", pinPath(), { status: 403, json: { code: 50013, message: "no" } })
    expect(await failure(f.unpin(args()))).toMatchObject({ code: "forbidden", details: { discord_code: 50013 } })
    expect(f.discord.api).toHaveLength(1)
    expect(f.isPinned()).toBe(true)
  })

  test.each([
    ["pinning", () => f.pin(args())],
    ["unpinning", () => f.unpin(args({ message: THEIRS }))],
  ])("a connection never made while %s is upstream_error and reads nothing back", async (_, call) => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(call())).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
  })
})

describe("the tools' targets", () => {
  test("name the label and the channel", async () => {
    expect(await writeTargets(discordPinAdd, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordPinAdd, args({ account: "nobody" }), f.ctx)).toEqual(["*"])
  })
})
