import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CATEGORY, FORUM } from "../chats/read.messages.testing"
import { failure } from "../chats/read.testing"
import { CHANNEL, DM, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import {
  createSearchFixture,
  FAR_CHANNEL,
  numbersOf,
  OTHER_SERVER,
  POST,
  said,
  seedWorld,
  store,
  THREAD,
  type SearchFixture,
} from "./search.testing"

let f: SearchFixture
beforeEach(async () => {
  f = await createSearchFixture()
  seedWorld(f)
  store(f, said(CHANNEL, 1), said(OTHER_CHANNEL, 2), said(THREAD, 3), said(POST, 4), said(FAR_CHANNEL, 5), said(DM, 6))
})
afterEach(async () => {
  await f.dispose()
})

const search = (args: Record<string, unknown>) => f.search({ method: "mirror", query: "text", ...args })

describe("the scope", () => {
  test("without one, everything is searched, DMs included", async () => {
    const result = await search({})
    expect(numbersOf(result)).toEqual([6, 5, 4, 3, 2, 1])
    expect(result.messages.find((message) => message.channel === DM)).toMatchObject({ server: null })
    expect(result.chats.find((chat) => chat.id === DM)).toMatchObject({ name: null, server: null })
  })

  test("a channel searches that channel alone", async () => {
    const result = await search({ channel: CHANNEL })
    expect(numbersOf(result)).toEqual([1])
    expect(result.chats).toMatchObject([{ id: CHANNEL, name: "general", server: SERVER }])
  })

  test("a DM can be searched by its id", async () => {
    expect(numbersOf(await search({ channel: DM }))).toEqual([6])
  })

  test("a server searches its channels, threads and posts, not another server's nor the DMs", async () => {
    const result = await search({ server: SERVER })
    expect(numbersOf(result)).toEqual([4, 3, 2, 1])
    expect(result.chats.map((chat) => chat.server)).toEqual([SERVER, SERVER, SERVER, SERVER])
    expect(numbersOf(await search({ server: OTHER_SERVER }))).toEqual([5])
  })

  test("a message whose own server is missing takes its channel's", async () => {
    f.seed((m) => m.prepare("UPDATE messages SET server = NULL").run())
    expect(numbersOf(await search({ server: SERVER }))).toEqual([4, 3, 2, 1])
    expect((await search({ channel: CHANNEL })).messages[0]!.server).toBe(SERVER)
  })

  test("the threads of a channel are searched with it only when asked", async () => {
    expect(numbersOf(await search({ channel: CHANNEL, threads: false }))).toEqual([1])
    const result = await search({ channel: CHANNEL, threads: true })
    expect(numbersOf(result)).toEqual([3, 1])
    expect(result.chats).toMatchObject([
      { id: THREAD, name: "a thread", server: SERVER },
      { id: CHANNEL, name: "general", server: SERVER },
    ])
    expect(numbersOf(await search({ channel: OTHER_CHANNEL, threads: true }))).toEqual([2])
  })

  test("a forum is searched through its posts, and only when asked", async () => {
    expect(numbersOf(await search({ channel: FORUM, threads: true }))).toEqual([4])
    const error = await failure(search({ channel: FORUM }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("forum channel")
    expect(error.message).toContain("threads")
  })

  test("a category holds no messages, with threads or without", async () => {
    for (const args of [{ channel: CATEGORY }, { channel: CATEGORY, threads: true }]) {
      const error = await failure(search(args))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("category")
    }
  })

  test("threads needs a channel", async () => {
    expect((await failure(search({ threads: true }))).code).toBe("invalid_argument")
    expect((await failure(search({ server: SERVER, threads: true }))).code).toBe("invalid_argument")
  })

  test("a channel and a server together are refused", async () => {
    expect((await failure(search({ channel: CHANNEL, server: SERVER }))).code).toBe("invalid_argument")
  })

  test("a channel or a server the mirror does not know is not found", async () => {
    const channel = await failure(search({ channel: "1400000000000000999" }))
    expect(channel.code).toBe("not_found")
    const server = await failure(search({ server: "1400000000000000998" }))
    expect(server.code).toBe("not_found")
    expect(server.message).toContain("discord_chat_read method servers")
  })

  test("a name is not an id", async () => {
    expect((await failure(search({ channel: "general" }))).code).toBe("invalid_argument")
    expect((await failure(search({ server: "My server" }))).code).toBe("invalid_argument")
  })
})
