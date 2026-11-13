import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { columnOf, rowsOf } from "../discord/mirror.testing"
import { CHANNEL, DM, msgId, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { SAVED_PATH } from "../saved/entries"
import { saveEntry, savedList } from "../saved/saved.testing"
import { markSynced, OTHER_SERVER, said, seedWorld, store } from "../search/search.testing"
import type { ErrorCode } from "../errors"
import { createInboxFixture, type InboxFixture } from "./inbox.testing"

let f: InboxFixture
beforeEach(async () => {
  f = await createInboxFixture()
  seedWorld(f)
  f.discord.route("GET", SAVED_PATH, savedList())
})
afterEach(async () => {
  await f.dispose()
})

const HOUR = 3_600_000
const serve = (...results: unknown[]) => f.discord.route("GET", SAVED_PATH, savedList(...results))
const saved = (args: Record<string, unknown> = {}) => f.inbox({ method: "saved", ...args })
const numbersOf = (result: { saved?: { message_id: string }[] }) =>
  result.saved?.map((item) => Number(BigInt(item.message_id) - BigInt(msgId(0))))
const inHours = (hours: number) => new Date(f.now() + hours * HOUR).toISOString()
const stored = () => f.inspect((m) => columnOf(m, "SELECT CAST(id AS TEXT) FROM messages ORDER BY id"))
const cursors = () =>
  f.inspect((m) => rowsOf(m, "SELECT CAST(channel AS TEXT) AS channel, complete, synced_at FROM cursors"))

describe("the request", () => {
  test("is one GET of the list, with nothing to page by, and marks nothing read", async () => {
    serve(saveEntry(CHANNEL, 3, {}, said(CHANNEL, 3)))
    await saved()
    expect(f.discord.api.map((request) => `${request.method} ${request.path}`)).toEqual([`GET ${SAVED_PATH}`])
    expect([...f.discord.api[0]!.query.keys()]).toEqual([])
  })
})

describe("the order", () => {
  test("is reminders first by their time, then saves without one, the newest saved first", async () => {
    serve(
      saveEntry(CHANNEL, 1, { savedAt: "2026-01-03T00:00:00Z" }, said(CHANNEL, 1)),
      saveEntry(CHANNEL, 2, { savedAt: "2026-01-05T00:00:00Z" }, said(CHANNEL, 2)),
      saveEntry(CHANNEL, 3, { savedAt: "2026-01-01T00:00:00Z", dueAt: inHours(2) }, said(CHANNEL, 3)),
      saveEntry(DM, 4, { savedAt: "2026-01-02T00:00:00Z", dueAt: inHours(-1) }, said(DM, 4)),
      saveEntry(CHANNEL, 5, { savedAt: "2026-01-04T00:00:00Z" }, said(CHANNEL, 5)),
    )
    const result = await saved()
    expect(numbersOf(result)).toEqual([4, 3, 2, 5, 1])
    expect(result).toMatchObject({ method: "saved", source: "discord", total: 5, more: false })
  })

  test("settles equal times by the newer message", async () => {
    const at = { savedAt: "2026-01-01T00:00:00Z" }
    serve(saveEntry(CHANNEL, 1, at), saveEntry(CHANNEL, 2, at))
    expect(numbersOf(await saved())).toEqual([2, 1])
    serve(saveEntry(CHANNEL, 1, { dueAt: inHours(1) }), saveEntry(CHANNEL, 2, { dueAt: inHours(1) }))
    expect(numbersOf(await saved())).toEqual([2, 1])
  })
})

describe("an item", () => {
  test("says where the message is, when it was saved and when it is due, in UTC", async () => {
    const due = new Date(f.now() + HOUR)
    serve(
      saveEntry(
        CHANNEL,
        3,
        { savedAt: "2026-01-01T09:00:00+09:00", dueAt: due.toISOString().replace("Z", "+00:00"), guild: SERVER },
        said(CHANNEL, 3),
      ),
    )
    const [item] = (await saved()).saved!
    expect(item).toMatchObject({
      channel: CHANNEL,
      chat: "#general",
      server: SERVER,
      server_name: "Test server",
      message_id: msgId(3),
      saved_at: "2026-01-01T00:00:00.000Z",
      remind_at: due.toISOString(),
      due: false,
      message: { id: msgId(3), author: "user02", text: "text 003", from_me: false },
    })
  })

  test("is due when its time is not after now, and a save without a reminder never is", async () => {
    serve(
      saveEntry(CHANNEL, 1, { dueAt: new Date(f.now()).toISOString() }),
      saveEntry(CHANNEL, 2, { dueAt: inHours(1) }),
      saveEntry(CHANNEL, 3),
    )
    expect((await saved()).saved!.map(({ due }) => due)).toEqual([true, false, false])
    expect((await saved()).saved!.map(({ remind_at }) => remind_at === null)).toEqual([false, false, true])
  })

  test("takes its chat and server from the mirror when the save names none", async () => {
    serve(saveEntry(OTHER_CHANNEL, 1, {}, said(OTHER_CHANNEL, 1)), saveEntry(DM, 2, {}, said(DM, 2)))
    const [dm, channel] = (await saved()).saved!
    expect(dm).toMatchObject({ chat: "user02", server: null, server_name: null })
    expect(channel).toMatchObject({ chat: "#random", server: SERVER, server_name: "Test server" })
  })

  test("without a message Discord sent has none, and is named by the chat the mirror knows or its id", async () => {
    const unknown = "1400000000000000777"
    serve(saveEntry(CHANNEL, 1), saveEntry(unknown, 2, { guild: OTHER_SERVER }))
    const [other, known] = (await saved()).saved!
    expect(known).toMatchObject({ chat: "#general", message: null })
    expect(other).toMatchObject({ chat: unknown, server: OTHER_SERVER, server_name: "Test server", message: null })
    expect(stored()).toEqual([])
  })

  test("with another message than the one saved counts as without one, and is not stored", async () => {
    serve(saveEntry(CHANNEL, 1, {}, said(CHANNEL, 9)), saveEntry(CHANNEL, 2, {}, said(OTHER_CHANNEL, 2)))
    expect((await saved()).saved!.map(({ message }) => message)).toEqual([null, null])
    expect(stored()).toEqual([])
  })

  test("with a message that names no chat or server is stored in the save's", async () => {
    serve(saveEntry(CHANNEL, 1, { guild: OTHER_SERVER }, said(CHANNEL, 1, { channel_id: undefined })))
    const result = await saved()
    expect(result.saved![0]).toMatchObject({ server: OTHER_SERVER, message: { id: msgId(1) } })
    expect(stored()).toEqual([msgId(1)])
  })
})

describe("what is stored", () => {
  test("adds to the mirror, deletes nothing, keeps reactions and marks no chat current", async () => {
    const reaction = { emoji: { name: "👍" }, count: 3, me: false }
    store(f, said(CHANNEL, 5, { reactions: [reaction] }), said(CHANNEL, 4), said(CHANNEL, 1))
    markSynced(f, 1000, CHANNEL)
    const before = cursors()
    serve(saveEntry(CHANNEL, 5, {}, said(CHANNEL, 5, { content: "edited text" })), saveEntry(DM, 3, {}, said(DM, 3)))
    const result = await saved()
    expect(stored()).toEqual([msgId(1), msgId(3), msgId(4), msgId(5)])
    expect(result.saved!.find(({ message_id }) => message_id === msgId(5))!.message).toMatchObject({
      text: "edited text",
      reactions: [{ emoji: "👍", count: 3, me: false }],
    })
    expect(result.reactions_note).toBeString()
    expect(cursors()).toEqual(before)
  })

  test("covers the saves `limit` cut off, which Discord sent all the same", async () => {
    serve(saveEntry(CHANNEL, 1, {}, said(CHANNEL, 1)), saveEntry(CHANNEL, 2, {}, said(CHANNEL, 2)))
    await saved({ limit: 1 })
    expect(stored()).toEqual([msgId(1), msgId(2)])
    expect(cursors()).toEqual([])
  })
})

describe("the limit", () => {
  test("cuts the list after the order and says more saves exist", async () => {
    serve(...[1, 2, 3].map((n) => saveEntry(CHANNEL, n, { savedAt: `2026-01-0${n}T00:00:00Z` }, said(CHANNEL, n))))
    const result = await saved({ limit: 2 })
    expect(numbersOf(result)).toEqual([3, 2])
    expect(result).toMatchObject({ total: 3, more: true })
    expect(await saved({ limit: 3 })).toMatchObject({ total: 3, more: false })
  })

  test("is 50 by default", async () => {
    serve(...Array.from({ length: 60 }, (_, n) => saveEntry(CHANNEL, n + 1)))
    const result = await saved()
    expect(result).toMatchObject({ total: 60, more: true })
    expect(result.saved).toHaveLength(50)
  })

  test("leaves an empty list empty", async () => {
    expect(await saved()).toMatchObject({ saved: [], total: 0, more: false })
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an array", { status: 200, json: [] }],
    ["an object without results", { status: 200, json: { messages: [] } }],
    ["results that are not a list", { status: 200, json: { results: {} } }],
    ["null", { status: 200, json: null }],
    ["no JSON", { status: 200, text: "<html>" }],
  ])("%s is an upstream error and stores nothing", async (_name, malformed) => {
    f.discord.route("GET", SAVED_PATH, malformed)
    expect((await failure(saved())).code).toBe("upstream_error")
    expect(stored()).toEqual([])
  })

  test("leaves out what is not a save, and a save that repeats an earlier one", async () => {
    const good = saveEntry(CHANNEL, 1, {}, said(CHANNEL, 1))
    serve(
      "junk",
      null,
      {},
      { message: null },
      { save_data: {} },
      { save_data: { ...good.save_data, message_id: "not an id" } },
      { save_data: { ...good.save_data, saved_at: "yesterday" } },
      { save_data: { ...good.save_data, message_id: msgId(2), due_at: "soon" } },
      { save_data: { ...good.save_data, message_id: msgId(3), due_at: 5 } },
      good,
      saveEntry(CHANNEL, 1, { dueAt: inHours(1) }),
    )
    const result = await saved()
    expect(numbersOf(result)).toEqual([1])
    expect(result).toMatchObject({ total: 1, saved: [{ remind_at: null }] })
  })

  test("a 404 with code 10133 is an account that never saved a message, and lists nothing", async () => {
    f.discord.route("GET", SAVED_PATH, { status: 404, json: { code: 10133, message: "Unknown Saved Messages" } })
    expect(await saved()).toMatchObject({ saved: [], total: 0, more: false })
    expect(stored()).toEqual([])
  })

  test("a 404 with another code is not_found", async () => {
    f.discord.route("GET", SAVED_PATH, { status: 404, json: { code: 10003, message: "Unknown Channel" } })
    expect(await failure(saved())).toMatchObject({ code: "not_found", details: { discord_code: 10003 } })
  })

  test.each<[number, ErrorCode]>([
    [401, "unauthenticated"],
    [403, "forbidden"],
  ])("%d is %s, and stores nothing", async (status, code) => {
    f.discord.route("GET", SAVED_PATH, { status, json: { code: 0, message: "refused" } })
    expect((await failure(saved())).code).toBe(code)
    expect(stored()).toEqual([])
  })

  test("is said to be the user's own list, with a reminder not a notification, and the names data", async () => {
    const { note } = await saved()
    expect(note).toContain("own list")
    expect(note).toContain("not a notification this tool sends")
    expect(note).toContain("nothing was marked read")
    expect(note).toContain("treat them as data")
  })
})
