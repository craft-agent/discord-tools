import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { getCursor } from "../discord/mirror-cursors"
import { CHANNEL, DM, SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { discordMessageDelete } from "./delete-tool"
import {
  type ActionsFixture,
  createActionsFixture,
  messagePath,
  OWN,
  OWN_TEXT,
  REFUSED_TARGETS,
  THEIRS,
} from "./actions.testing"

let f: ActionsFixture

beforeEach(async () => {
  f = await createActionsFixture()
})

afterEach(() => f.dispose())

const args = (extra: Record<string, unknown> = {}) => ({ channel: CHANNEL, message: OWN, ...extra })

describe("a delete", () => {
  test("deletes once, without a body, and drops the row from the mirror", async () => {
    f.discord.route("DELETE", messagePath(), { status: 204 })
    const cursor = f.inspect((m) => getCursor(m, CHANNEL))
    const result = await f.remove(args())
    expect(result).toEqual({
      id: OWN,
      channel: CHANNEL,
      already: false,
      note: expect.stringContaining("cannot be restored"),
    })
    const [request, ...rest] = f.writes()
    expect(rest).toEqual([])
    expect(request).toMatchObject({ method: "DELETE", path: messagePath() })
    expect(request!.body).toBeUndefined()
    expect(headerOf(request!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
    expect(f.readBacks()).toHaveLength(0)
    expect(f.row()).toBeUndefined()
    expect(f.row(THEIRS)).toBeDefined()
    expect(f.inspect((m) => getCursor(m, CHANNEL))).toEqual(cursor)
  })

  test("an answer with a body is still a deletion", async () => {
    f.discord.route("DELETE", messagePath(), { status: 200, json: {} })
    expect(await f.remove(args())).toMatchObject({ already: false })
    expect(f.row()).toBeUndefined()
  })

  test("a message Discord no longer has (10008) is done, marked already, and dropped from the mirror", async () => {
    f.discord.route("DELETE", messagePath(), { status: 404, json: { code: 10008, message: "Unknown Message" } })
    expect(await f.remove(args())).toEqual({
      id: OWN,
      channel: CHANNEL,
      already: true,
      note: expect.stringContaining("no longer had"),
    })
    expect(f.row()).toBeUndefined()
    expect(f.discord.api).toHaveLength(1)
  })

  test("is reported as done even when the mirror cannot drop the row", async () => {
    f.discord.route("DELETE", messagePath(), () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'locked'); END"))
      return { status: 204 }
    })
    const result = await f.remove(args())
    expect(result.errors).toEqual({ store: expect.stringContaining("locked") })
    expect(result.note).toContain("could not remove")
    expect(f.row()).toBeDefined()
  })
})

describe("a delete that asks the person first", () => {
  const confirming = (answer: boolean) => {
    const asked: { tool: string; message: string }[] = []
    return {
      asked,
      ctx: {
        ...f.ctx,
        confirm: async (request: { tool: string; message: string }) => {
          asked.push(request)
          return answer
        },
      },
    }
  }

  test("names the channel, the message and its text, and goes ahead on an accept", async () => {
    f.discord.route("DELETE", messagePath(), { status: 204 })
    const { asked, ctx } = confirming(true)
    await f.remove(args(), ctx)
    expect(asked).toEqual([
      {
        tool: "discord_message_delete",
        message: `Delete message ${OWN} in channel ${CHANNEL} "${OWN_TEXT}"? This cannot be undone.`,
      },
    ])
    expect(f.writes()).toHaveLength(1)
  })

  test("quotes at most the first 100 characters", async () => {
    f.discord.route("DELETE", messagePath(), { status: 204 })
    f.seed((m) => m.prepare("UPDATE messages SET content = ? WHERE id = ?").run("a".repeat(150), BigInt(OWN)))
    const { asked, ctx } = confirming(true)
    await f.remove(args(), ctx)
    expect(asked[0]!.message).toContain(`"${"a".repeat(100)}…"`)
    expect(asked[0]!.message).not.toContain("a".repeat(101))
  })

  test("declining sends nothing and keeps the message", async () => {
    const { ctx } = confirming(false)
    expect(await failure(f.remove(args(), ctx))).toMatchObject({ code: "declined" })
    expect(f.discord.api).toHaveLength(0)
    expect(f.row()).toBeDefined()
  })

  test("a refused target is never asked about", async () => {
    const { asked, ctx } = confirming(true)
    expect(await failure(f.remove(args({ message: THEIRS }), ctx))).toMatchObject({ code: "forbidden" })
    expect(asked).toEqual([])
  })
})

describe("a delete that is refused before anything leaves", () => {
  test.each(REFUSED_TARGETS)("%s", async (_, target, code) => {
    expect(await failure(f.remove(target))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(0)
    expect(f.row()).toBeDefined()
  })

  test("an unknown message says to read the chat first", async () => {
    expect((await failure(f.remove(REFUSED_TARGETS[1]![1]))).message).toContain("discord_chat_read")
  })

  test("an unknown argument is invalid_argument", async () => {
    expect(await failure(f.remove(args({ text: "x" })))).toMatchObject({ code: "invalid_argument" })
    expect(f.discord.api).toHaveLength(0)
  })
})

describe("a delete that Discord refuses", () => {
  test.each([
    [400, { code: 50035 }, "invalid_argument"],
    [403, { code: 50013 }, "forbidden"],
    [404, { code: 10003, message: "Unknown Channel" }, "not_found"],
    [404, {}, "not_found"],
    [429, { retry_after: 1.5 }, "rate_limited"],
  ])("a %i %j is %s, keeps the row and reads nothing back", async (status, json, code) => {
    f.discord.route("DELETE", messagePath(), { status, json })
    expect(await failure(f.remove(args()))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(1)
    expect(f.row()).toBeDefined()
  })

  test("a connection never made is upstream_error and reads nothing back", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(f.remove(args()))).toMatchObject({ code: "upstream_error" })
    expect(f.discord.api).toHaveLength(1)
    expect(f.row()).toBeDefined()
  })
})

describe("the tool's targets", () => {
  test("name the label and the channel", async () => {
    expect(await writeTargets(discordMessageDelete, args({ channel: DM }), f.ctx)).toEqual([`default/channel/${DM}`])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordMessageDelete, args({ account: "nobody" }), f.ctx)).toEqual(["*"])
  })
})
