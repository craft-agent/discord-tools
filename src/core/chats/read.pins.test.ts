import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestHistoryPage } from "../discord/ingest"
import { rowsOf, storedMessageIds } from "../discord/mirror.testing"
import { CHANNEL, messageObject, msgId, OTHER_CHANNEL } from "../discord/objects.testing"
import { seedChannels, seedHistory } from "./read.messages.testing"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"

const PINNED_NEW = "2026-02-03T04:05:06.000000+00:00"
const PINNED_OLD = "2026-01-02T03:04:05.000000+00:00"

const pin = (n: number, pinned_at: string, extra: Record<string, unknown> = {}) => ({
  pinned_at,
  message: messageObject(msgId(n), CHANNEL, extra),
})

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  seedChannels(f)
})
afterEach(async () => {
  await f.dispose()
})

const pins = (args: Record<string, unknown> = {}) => f.read({ method: "pins", channel: CHANNEL, ...args })
const serve = (json: unknown) => f.discord.route("GET", `/channels/${CHANNEL}/messages/pins`, { status: 200, json })
const requests = () => f.discord.api.filter((request) => request.path === `/channels/${CHANNEL}/messages/pins`)
const stored = () => f.inspect((m) => storedMessageIds(m, CHANNEL))
const cursors = () =>
  f.inspect((m) =>
    rowsOf(
      m,
      "SELECT CAST(channel AS TEXT) AS channel, CAST(newest AS TEXT) AS newest, complete, synced_at FROM cursors",
    ),
  )

describe("method pins", () => {
  test("asks for the default limit, and for pins before an instant as ISO", async () => {
    serve({ items: [], has_more: false })
    await pins()
    expect(Object.fromEntries(requests()[0]!.query)).toEqual({ limit: "50" })
    await pins({ limit: 5, before: "2026-01-02" })
    expect(Object.fromEntries(requests()[1]!.query)).toEqual({ limit: "5", before: "2026-01-02T00:00:00.000Z" })
    await pins({ before: "2026-01-02T12:00:00+09:00" })
    expect(requests()[2]!.query.get("before")).toBe("2026-01-02T03:00:00.000Z")
  })

  test("answers in Discord's order with each pin time, and pages by the last pin time", async () => {
    serve({ items: [pin(5, PINNED_NEW), pin(2, PINNED_OLD)], has_more: true })
    const result = await pins({ limit: 2 })
    expect(result).toMatchObject({ source: "live", channel: CHANNEL, next_before: PINNED_OLD })
    expect(result.pins?.map((item) => [item.pinned_at, item.message.id])).toEqual([
      [PINNED_NEW, msgId(5)],
      [PINNED_OLD, msgId(2)],
    ])
    expect(result.pins?.[0]?.message).toMatchObject({ text: `text ${msgId(5).slice(-3)}`, author: "user02" })
    serve({ items: [pin(5, PINNED_NEW)], has_more: false })
    expect(await pins()).toMatchObject({ next_before: null })
    serve({ items: [], has_more: true })
    expect((await pins()).next_before).toBeNull()
  })

  test("stores the messages, keeps stored reactions and deletes nothing", async () => {
    seedHistory(f, [1, 2, 3], { complete: true })
    seedHistory(f, [4], { channel: OTHER_CHANNEL })
    f.seed((m) =>
      ingestHistoryPage(
        m,
        f.ingestContext(),
        CHANNEL,
        [messageObject(msgId(2), CHANNEL, { reactions: [{ emoji: { name: "👍" }, count: 3, me: false }] })],
        { after: msgId(2), before: msgId(3) },
      ),
    )
    const before = cursors()
    serve({ items: [pin(2, PINNED_OLD), pin(9, PINNED_NEW)], has_more: false })
    const result = await pins()
    expect(stored()).toEqual([msgId(1), msgId(2), msgId(3), msgId(9)])
    expect(f.inspect((m) => storedMessageIds(m, OTHER_CHANNEL))).toEqual([msgId(4)])
    expect(result.pins?.[0]?.message.reactions).toEqual([{ emoji: "👍", count: 3, me: false }])
    expect(result.reactions_note).toBeString()
    expect(cursors()).toEqual(before)
  })

  test("a message id as before is refused, naming the pin time", async () => {
    const error = await failure(pins({ before: msgId(5) }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("pin time")
    expect((await failure(pins({ before: "yesterday" }))).code).toBe("invalid_argument")
    expect((await failure(pins({ limit: 51 }))).code).toBe("invalid_argument")
    expect(requests()).toHaveLength(0)
  })
})

describe("method pins: Discord's answer", () => {
  test.each([
    ["not an object", [pin(1, PINNED_NEW)]],
    ["no has_more", { items: [] }],
    ["more than the limit", { items: [pin(1, PINNED_NEW), pin(2, PINNED_OLD)], has_more: false }],
    ["an unreadable pin time", { items: [pin(1, "last week")], has_more: false }],
    [
      "a message of another channel",
      { items: [{ pinned_at: PINNED_NEW, message: messageObject(msgId(1), OTHER_CHANNEL) }], has_more: false },
    ],
    ["a message without text", { items: [pin(1, PINNED_NEW, { content: 5 })], has_more: false }],
    ["the same message twice", { items: [pin(1, PINNED_NEW), pin(1, PINNED_OLD)], has_more: false }],
    ["an item that is no object", { items: ["x"], has_more: false }],
  ])("%s is an upstream error and stores nothing", async (_name, answer) => {
    serve(answer)
    expect((await failure(pins({ limit: 1 }))).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test("a refusal is forbidden", async () => {
    f.discord.route("GET", `/channels/${CHANNEL}/messages/pins`, {
      status: 403,
      json: { code: 50001, message: "Missing Access" },
    })
    expect((await failure(pins())).code).toBe("forbidden")
    expect(stored()).toEqual([])
  })

  test("an unknown channel is not found and makes no request", async () => {
    expect((await failure(pins({ channel: "1400000000000000999" }))).code).toBe("not_found")
    expect(f.discord.requests).toHaveLength(0)
  })
})
