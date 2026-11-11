import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { SERVER } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { requestsOf, seedServers } from "../people/people.testing"
import { emojisPath, stickersPath } from "./emojis"
import { createServerFixture, type ServerFixture, storedServersOf } from "./servers.testing"

const id = (n: number) => `14000000000000006${String(n).padStart(2, "0")}`
const ROLE = "1400000000000000501"

let f: ServerFixture
beforeEach(async () => {
  f = await createServerFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const emojis = [
  { id: id(3), name: "wave", animated: true, managed: false, available: false, roles: [ROLE, ROLE, "x"] },
  { id: id(2), name: "Teacup", animated: false, managed: true },
  { id: id(1), name: "teacup" },
  { id: id(4), name: "Zebra", roles: [] },
]
const stickers = [
  { id: id(12), name: "Hello", description: "A greeting", tags: "wave, hi", format_type: 3, available: true },
  { id: id(11), name: "Bye", description: "", tags: "", format_type: 1 },
  { id: id(13), name: "Cat", format_type: 2, available: false },
  { id: id(14), name: "Dog", format_type: 4 },
  { id: id(15), name: "Odd", format_type: 9 },
]

const serve = (emojiList: unknown = emojis, stickerList: unknown = stickers) =>
  f.discord
    .route("GET", emojisPath(SERVER), { status: 200, json: emojiList })
    .route("GET", stickersPath(SERVER), { status: 200, json: stickerList })
const read = (args: Record<string, unknown> = {}) => f.servers({ method: "emojis", server: SERVER, ...args })

describe("the request", () => {
  test("is the emojis, then the stickers, both GET with no query", async () => {
    serve()
    await read()
    expect(requestsOf(f)).toEqual([`GET ${emojisPath(SERVER)}`, `GET ${stickersPath(SERVER)}`])
    expect(f.discord.api.map((request) => [...request.query.keys()])).toEqual([[], []])
  })
})

describe("the result", () => {
  test("lists the emojis by name ignoring case, then id, with the text that uses each", async () => {
    serve()
    const result = await read()
    expect(result.emojis).toEqual([
      {
        id: id(1),
        name: "teacup",
        animated: false,
        managed: false,
        available: true,
        roles: [],
        use: `<:teacup:${id(1)}>`,
      },
      {
        id: id(2),
        name: "Teacup",
        animated: false,
        managed: true,
        available: true,
        roles: [],
        use: `<:Teacup:${id(2)}>`,
      },
      {
        id: id(3),
        name: "wave",
        animated: true,
        managed: false,
        available: false,
        roles: [ROLE],
        use: `<a:wave:${id(3)}>`,
      },
      {
        id: id(4),
        name: "Zebra",
        animated: false,
        managed: false,
        available: true,
        roles: [],
        use: `<:Zebra:${id(4)}>`,
      },
    ])
    expect(result).toMatchObject({ emoji_total: 4, sticker_total: 5, truncated: { emojis: false, stickers: false } })
    expect(result.stickers_missing).toBe(false)
  })

  test("lists the stickers by name ignoring case, with their format", async () => {
    serve()
    const result = await read()
    expect(result.stickers?.map((sticker) => [sticker.name, sticker.format, sticker.available])).toEqual([
      ["Bye", "png", true],
      ["Cat", "apng", false],
      ["Dog", "gif", true],
      ["Hello", "lottie", true],
      ["Odd", null, true],
    ])
    expect(result.stickers?.[0]).toEqual({
      id: id(11),
      name: "Bye",
      description: null,
      tags: null,
      format: "png",
      available: true,
    })
    expect(result.stickers?.[3]).toMatchObject({ description: "A greeting", tags: "wave, hi" })
  })

  test("filters emojis by name and stickers by name or tags, ignoring case", async () => {
    serve()
    const result = await read({ query: "WAVE" })
    expect(result.emojis?.map((emoji) => emoji.name)).toEqual(["wave"])
    expect(result.stickers?.map((sticker) => sticker.name)).toEqual(["Hello"])
    expect(result).toMatchObject({ emoji_total: 1, sticker_total: 1 })
    expect((await read({ query: "cup" })).emojis?.map((emoji) => emoji.id)).toEqual([id(1), id(2)])
    expect(await read({ query: "nothing" })).toMatchObject({
      emojis: [],
      stickers: [],
      emoji_total: 0,
      sticker_total: 0,
    })
  })

  test("caps each list at the limit, counting what matched before it and saying which it cut", async () => {
    serve()
    const result = await read({ limit: 3 })
    expect(result.emojis?.map((emoji) => emoji.name)).toEqual(["teacup", "Teacup", "wave"])
    expect(result.stickers?.map((sticker) => sticker.name)).toEqual(["Bye", "Cat", "Dog"])
    expect(result).toMatchObject({ emoji_total: 4, sticker_total: 5, truncated: { emojis: true, stickers: true } })
    expect((await read({ limit: 4 })).truncated).toEqual({ emojis: false, stickers: true })
    expect((await read({ query: "o", limit: 1 })).truncated).toEqual({ emojis: false, stickers: true })
  })

  test("lists up to 100 of each when no limit is given", async () => {
    const many = Array.from({ length: 101 }, (_, n) => ({
      id: String(1400000000000001000n + BigInt(n)),
      name: `e${n}`,
    }))
    serve(many, many)
    const result = await read()
    expect(result.emojis).toHaveLength(100)
    expect(result.stickers).toHaveLength(100)
    expect(result).toMatchObject({ emoji_total: 101, sticker_total: 101, truncated: { emojis: true, stickers: true } })
  })

  test("leaves out an entry without a valid id or a name", async () => {
    serve([{ name: "no id" }, { id: id(1) }, ...emojis], [{ name: "no id" }, { id: id(1) }, ...stickers])
    expect(await read()).toMatchObject({ emoji_total: 4, sticker_total: 5 })
  })

  test("says what `use` does, that the names are people's words and that nothing was stored", async () => {
    serve()
    const { note } = await read()
    expect(note).toContain("`use` text puts it in a message")
    expect(note).toContain("Nothing was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })

  test("writes nothing to the mirror", async () => {
    const before = storedServersOf(f)
    serve()
    await read()
    expect(storedServersOf(f)).toEqual(before)
  })
})

describe("Discord's answer", () => {
  test("403 for the stickers leaves the emojis listed, with no stickers and a flag", async () => {
    f.discord
      .route("GET", emojisPath(SERVER), { status: 200, json: emojis })
      .route("GET", stickersPath(SERVER), { status: 403, json: { code: 50013, message: "Missing Permissions" } })
    const result = await read()
    expect(result.emojis).toHaveLength(4)
    expect(result).toMatchObject({ stickers: [], sticker_total: 0, stickers_missing: true })
    expect(result.truncated).toEqual({ emojis: false, stickers: false })
  })

  test.each<[number, ErrorCode]>([
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d for the stickers is %s, as it is", async (status, code) => {
    f.discord
      .route("GET", emojisPath(SERVER), { status: 200, json: emojis })
      .route("GET", stickersPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(read())).code).toBe(code)
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d for the emojis is %s, and asks no stickers", async (status, code) => {
    f.discord.route("GET", emojisPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(read())).code).toBe(code)
    expect(requestsOf(f)).toEqual([`GET ${emojisPath(SERVER)}`])
  })

  test.each([
    ["emojis that are an object", {}, stickers],
    ["emojis that are null", null, stickers],
    ["an emoji that is no object", [...emojis, "x"], stickers],
    ["stickers that are an object", emojis, {}],
    ["stickers that are null", emojis, null],
    ["a sticker that is no object", emojis, [...stickers, 5]],
  ])("%s is an upstream error", async (_name, emojiList, stickerList) => {
    serve(emojiList, stickerList)
    expect((await failure(read())).code).toBe("upstream_error")
  })
})
