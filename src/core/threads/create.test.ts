import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { CHANNEL, SERVER } from "../discord/objects.testing"
import { THREAD_CREATED_NOTE, THREAD_UNSTORED_NOTE } from "./create"
import {
  ANNOUNCEMENT,
  createThreadsFixture,
  fromMessagePath,
  NAME,
  NEW_THREAD,
  SAID,
  startPath,
  threadObject,
  type ThreadsFixture,
} from "./threads.testing"

let f: ThreadsFixture

beforeEach(async () => {
  f = await createThreadsFixture()
})

afterEach(() => f.dispose())

/** The JSON body of the one write the fake Discord received. */
const sentBody = () => JSON.parse(f.writes()[0]!.body!) as Record<string, unknown>

describe("the request", () => {
  test("from a message posts the name alone to the message's threads, with the channel's page as referer", async () => {
    f.discord.route("POST", fromMessagePath(), { status: 200, json: threadObject(SAID) })
    await f.create({ channel: CHANNEL, message: SAID, name: NAME })
    expect(f.writes().map((request) => `${request.method} ${request.path}`)).toEqual([`POST ${fromMessagePath()}`])
    expect(sentBody()).toEqual({ name: NAME })
    expect(headerOf(f.writes()[0]!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
  })

  test("from a message carries the archive time when given", async () => {
    f.discord.route("POST", fromMessagePath(), { status: 200, json: threadObject(SAID) })
    await f.create({ channel: CHANNEL, message: SAID, name: NAME, auto_archive: 60 })
    expect(sentBody()).toEqual({ name: NAME, auto_archive_duration: 60 })
  })

  test.each([
    ["public by default", {}, { type: 11 }],
    ["public when private is false", { private: false }, { type: 11 }],
    ["private when asked for", { private: true }, { type: 12 }],
    ["with the archive time when given", { auto_archive: 10080 }, { type: 11, auto_archive_duration: 10080 }],
  ])("without a message posts the name and a type, %s", async (_, extra, body) => {
    f.discord.route("POST", startPath(), { status: 200, json: threadObject(NEW_THREAD, { type: body.type }) })
    await f.create({ channel: CHANNEL, name: NAME, ...extra })
    expect(f.writes().map((request) => `${request.method} ${request.path}`)).toEqual([`POST ${startPath()}`])
    expect(sentBody()).toEqual({ name: NAME, ...body })
    expect(headerOf(f.writes()[0]!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
  })

  test("sends a name exactly as given and accepts one of 100 characters", async () => {
    const name = ` ${"é".repeat(98)} `
    f.discord.route("POST", startPath(), { status: 200, json: threadObject(NEW_THREAD, { name }) })
    await f.create({ channel: CHANNEL, name })
    expect(sentBody().name).toBe(name)
  })

  test("in an announcement channel posts a public thread to that channel", async () => {
    f.discord.route("POST", startPath(ANNOUNCEMENT), {
      status: 200,
      json: threadObject(NEW_THREAD, { type: 10, parent_id: ANNOUNCEMENT }),
    })
    const result = await f.create({ channel: ANNOUNCEMENT, name: NAME })
    expect(sentBody()).toEqual({ name: NAME, type: 11 })
    expect(result).toMatchObject({ channel: ANNOUNCEMENT, type: "announcement" })
  })

  test("is never retried when Discord refuses it or the connection is never made", async () => {
    f.discord.route("POST", startPath(), { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    expect((await failure(f.create({ channel: CHANNEL, name: NAME }))).code).toBe("forbidden")
    expect(f.writes()).toHaveLength(1)
    f.discord.failNext({ dispatched: false })
    expect((await failure(f.create({ channel: CHANNEL, name: NAME }))).code).not.toBe("uncertain")
    expect(f.writes()).toHaveLength(2)
    expect(f.reads()).toEqual([])
  })
})

describe("the result", () => {
  test("from a message names the thread of that message", async () => {
    f.discord.route("POST", fromMessagePath(), { status: 200, json: threadObject(SAID) })
    expect(await f.create({ channel: CHANNEL, message: SAID, name: NAME })).toEqual({
      id: SAID,
      channel: CHANNEL,
      server: SERVER,
      name: NAME,
      type: "public",
      from_message: SAID,
      archives_after: 1440,
      note: THREAD_CREATED_NOTE,
    })
  })

  test("without a message gives a private thread, the name and time Discord says, and no message", async () => {
    f.discord.route("POST", startPath(), {
      status: 200,
      json: threadObject(NEW_THREAD, {
        type: 12,
        name: "as Discord keeps it",
        thread_metadata: { archived: false, auto_archive_duration: 60 },
      }),
    })
    expect(await f.create({ channel: CHANNEL, name: NAME, private: true })).toMatchObject({
      id: NEW_THREAD,
      type: "private",
      name: "as Discord keeps it",
      from_message: null,
      archives_after: 60,
    })
  })

  test("says null for an archive time Discord does not give", async () => {
    f.discord.route("POST", startPath(), { status: 200, json: threadObject(NEW_THREAD, { thread_metadata: {} }) })
    expect(await f.create({ channel: CHANNEL, name: NAME })).toMatchObject({ archives_after: null })
  })

  test("stores the thread without marking anything current", async () => {
    const before = f.isCurrent(CHANNEL)
    expect(before).toBe(true)
    f.discord.route("POST", startPath(), { status: 200, json: threadObject(NEW_THREAD) })
    await f.create({ channel: CHANNEL, name: NAME })
    expect(f.row(NEW_THREAD)).toMatchObject({ type: 11, name: NAME, parent: CHANNEL })
    expect(f.row(NEW_THREAD)!.thread).toContain('"owner":"1400000000000000001"')
    expect(f.isCurrent(NEW_THREAD)).toBe(false)
    expect(f.isCurrent(CHANNEL)).toBe(before)
    expect(f.reads()).toEqual([])
  })

  test("is reported as created even when the mirror cannot store the thread", async () => {
    f.discord.route("POST", startPath(), () => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE INSERT ON channels BEGIN SELECT RAISE(ABORT, 'full'); END"))
      return { status: 200, json: threadObject(NEW_THREAD) }
    })
    const result = await f.create({ channel: CHANNEL, name: NAME })
    expect(result).toMatchObject({ id: NEW_THREAD, note: THREAD_UNSTORED_NOTE })
    expect(result.errors).toEqual({ store: expect.stringContaining("full") })
    expect(f.row(NEW_THREAD)).toBeUndefined()
    expect(f.reads()).toEqual([])
  })
})
