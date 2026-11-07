import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestChannels } from "../discord/ingest"
import { rowsOf, storedMessageIds } from "../discord/mirror.testing"
import { ALICE, CHANNEL, channelObject, messageObject, msgId, SERVER } from "../discord/objects.testing"
import { CATEGORY, FORUM, seedChannels, seedHistory } from "./read.messages.testing"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"

const THREAD = "1400000000000000401"
const POST = "1400000000000000402"
const TAG_A = "1400000000000000501"
const TAG_B = "1400000000000000502"
const TAGS = [
  { id: TAG_A, name: "Bug", emoji_name: "🐛" },
  { id: TAG_B, name: "Idea", emoji_name: null },
]

const threadObject = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
  channelObject(id, {
    type: 11,
    parent_id: parent,
    name: `thread ${id.slice(-3)}`,
    owner_id: ALICE,
    message_count: 4,
    last_message_id: msgId(7),
    flags: 0,
    applied_tags: [],
    thread_metadata: { archived: false, locked: false, create_timestamp: "2026-03-04T05:06:07.000000+00:00" },
    ...extra,
  })

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  seedChannels(f)
})
afterEach(async () => {
  await f.dispose()
})

const threads = (args: Record<string, unknown> = {}) => f.read({ method: "threads", channel: CHANNEL, ...args })
const serve = (json: unknown, channel = CHANNEL) =>
  f.discord.route("GET", `/channels/${channel}/threads/search`, { status: 200, json })
const searches = (channel = CHANNEL) =>
  f.discord.api.filter((request) => request.path === `/channels/${channel}/threads/search`)
const storedThreads = () =>
  f.inspect((m) => rowsOf(m, "SELECT CAST(id AS TEXT) AS id, type FROM channels WHERE type = 11"))
const cursors = () =>
  f.inspect((m) =>
    rowsOf(
      m,
      "SELECT CAST(channel AS TEXT) AS channel, CAST(newest AS TEXT) AS newest, CAST(oldest AS TEXT) AS oldest, complete, synced_at FROM cursors",
    ),
  )
const seedForumTags = () =>
  f.seed((m) =>
    ingestChannels(m, f.ingestContext(), [channelObject(FORUM, { type: 15, available_tags: TAGS })], SERVER),
  )

describe("method threads: the request", () => {
  test("asks for the newest activity first by default and maps each argument", async () => {
    serve({ threads: [] })
    await threads()
    const query = searches()[0]!.query
    expect(Object.fromEntries(query)).toEqual({
      sort_by: "last_message_time",
      sort_order: "desc",
      limit: "25",
      offset: "0",
    })

    await threads({ sort: "created", archived: true, limit: 10, offset: 20 })
    expect(Object.fromEntries(searches()[1]!.query)).toEqual({
      sort_by: "creation_time",
      sort_order: "desc",
      limit: "10",
      offset: "20",
      archived: "true",
    })
    await threads({ archived: false })
    expect(searches()[2]!.query.get("archived")).toBe("false")
  })

  test("sends a tag of the forum and refuses an offset over the cap", async () => {
    seedForumTags()
    serve({ threads: [] }, FORUM)
    await threads({ channel: FORUM, tag: TAG_B })
    expect(searches(FORUM)[0]!.query.get("tag")).toBe(TAG_B)
    const error = await failure(threads({ offset: 9976 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("9975")
    expect(searches()).toHaveLength(0)
  })
})

describe("method threads: the result", () => {
  test("next_offset follows has_more and stops at the cap", async () => {
    serve({ threads: [threadObject(THREAD, CHANNEL)], has_more: true })
    expect(await threads({ limit: 10, offset: 5 })).toMatchObject({ source: "live", channel: CHANNEL, next_offset: 15 })
    expect((await threads({ limit: 25, offset: 9950 })).next_offset).toBe(9975)
    expect((await threads({ limit: 25, offset: 9975 })).next_offset).toBeNull()
    serve({ threads: [threadObject(THREAD, CHANNEL)], has_more: false })
    expect((await threads()).next_offset).toBeNull()
    serve({ threads: [] })
    expect(await threads()).toMatchObject({ threads: [], tags: null, next_offset: null })
  })

  test("items carry the state, the applied tags, the owner and the first post as is", async () => {
    seedForumTags()
    const long = "x".repeat(500)
    serve(
      {
        threads: [
          threadObject(POST, FORUM, {
            applied_tags: [TAG_A, "1400000000000000999"],
            flags: 2,
            thread_metadata: { archived: true, locked: true },
          }),
          threadObject(THREAD, FORUM),
        ],
        first_messages: [messageObject(msgId(1), POST, { content: long })],
        has_more: false,
      },
      FORUM,
    )
    const result = await threads({ channel: FORUM })
    expect(result.tags).toEqual([
      { id: TAG_A, name: "Bug", emoji: "🐛" },
      { id: TAG_B, name: "Idea", emoji: null },
    ])
    expect(result.threads?.map((thread) => thread.id)).toEqual([POST, THREAD])
    expect(result.threads?.[0]).toEqual({
      id: POST,
      name: "thread 402",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      last_message_at: expect.stringMatching(/Z$/),
      archived: true,
      locked: true,
      pinned: true,
      message_count: 4,
      tags: [
        { id: TAG_A, name: "Bug" },
        { id: "1400000000000000999", name: null },
      ],
      owner_id: ALICE,
      owner: "user02",
      first_post: { id: msgId(1), text: long, author_id: ALICE, author: "user02" },
    })
    expect(result.threads?.[1]).toMatchObject({
      created_at: "2026-03-04T05:06:07.000Z",
      first_post: null,
      pinned: false,
    })
  })
})

describe("method threads: the mirror", () => {
  test("stores threads and first posts, marks nothing current and deletes nothing", async () => {
    seedHistory(f, [1, 2, 3], { complete: true })
    const before = cursors()
    serve({
      threads: [threadObject(THREAD, CHANNEL)],
      first_messages: [messageObject(msgId(9), THREAD)],
    })
    await threads()
    expect(storedThreads()).toEqual([{ id: THREAD, type: 11 }])
    expect(f.inspect((m) => storedMessageIds(m, THREAD))).toEqual([msgId(9)])
    expect(f.inspect((m) => storedMessageIds(m, CHANNEL))).toEqual([msgId(1), msgId(2), msgId(3)])
    expect(cursors()).toEqual(before)
  })

  test("a returned thread is a channel that method messages can read", async () => {
    serve({ threads: [threadObject(THREAD, CHANNEL)] })
    await threads()
    f.discord.route("GET", `/channels/${THREAD}/messages`, { status: 200, json: [messageObject(msgId(3), THREAD)] })
    const read = await f.read({ method: "messages", channel: THREAD })
    expect(read).toMatchObject({ channel: THREAD, messages: [{ id: msgId(3) }] })
  })
})

describe("method threads: forum tags", () => {
  test("reads the forum once when its tags are not stored, then uses the mirror", async () => {
    f.discord.route("GET", `/channels/${FORUM}`, {
      status: 200,
      json: channelObject(FORUM, { type: 15, available_tags: TAGS }),
    })
    serve({ threads: [] }, FORUM)
    const first = await threads({ channel: FORUM, tag: TAG_A })
    expect(first.tags).toHaveLength(2)
    await threads({ channel: FORUM })
    const reads = f.discord.api.filter((request) => request.path === `/channels/${FORUM}`)
    expect(reads).toHaveLength(1)
    expect(f.inspect((m) => rowsOf(m, "SELECT forum FROM channels WHERE id = ?", BigInt(FORUM)))).not.toEqual([
      { forum: null },
    ])
  })

  test("a forum answer for another channel is an upstream error", async () => {
    f.discord.route("GET", `/channels/${FORUM}`, { status: 200, json: channelObject(CHANNEL, { type: 15 }) })
    expect((await failure(threads({ channel: FORUM }))).code).toBe("upstream_error")
    expect(searches(FORUM)).toHaveLength(0)
  })

  test("an unknown tag lists the valid ones and makes no search", async () => {
    seedForumTags()
    const error = await failure(threads({ channel: FORUM, tag: "1400000000000000999" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${TAG_A} (Bug)`)
    expect(error.message).toContain(`${TAG_B} (Idea)`)
    expect(searches(FORUM)).toHaveLength(0)
  })

  test("a tag that is not an id is refused, and so is a tag on a text channel", async () => {
    expect((await failure(threads({ channel: FORUM, tag: "Bug" }))).code).toBe("invalid_argument")
    const error = await failure(threads({ tag: TAG_A }))
    expect(error.code).toBe("invalid_argument")
    expect(searches()).toHaveLength(0)
  })
})

describe("method threads: the parent and Discord's answer", () => {
  test("a category, a thread or an unknown channel is refused without a request", async () => {
    serve({ threads: [threadObject(THREAD, CHANNEL)] })
    await threads()
    for (const channel of [CATEGORY, THREAD]) {
      const error = await failure(threads({ channel }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("text, announcement, forum or media")
    }
    expect((await failure(threads({ channel: "1400000000000000999" }))).code).toBe("not_found")
    expect(searches()).toHaveLength(1)
  })

  test.each([
    ["a thread of another parent", { threads: [threadObject(THREAD, FORUM)] }],
    ["a channel that is no thread", { threads: [{ ...threadObject(THREAD, CHANNEL), type: 0 }] }],
    ["more threads than the limit", { threads: [threadObject(THREAD, CHANNEL), threadObject(POST, CHANNEL)] }],
    [
      "a first post of another thread",
      { threads: [threadObject(THREAD, CHANNEL)], first_messages: [messageObject(msgId(1), POST)] },
    ],
    ["not an object", [threadObject(THREAD, CHANNEL)]],
    ["a has_more that is no boolean", { threads: [], has_more: "yes" }],
  ])("%s is an upstream error and stores nothing", async (_name, answer) => {
    serve(answer)
    expect((await failure(threads({ limit: 1 }))).code).toBe("upstream_error")
    expect(storedThreads()).toEqual([])
    expect(f.inspect((m) => storedMessageIds(m, POST))).toEqual([])
  })
})
