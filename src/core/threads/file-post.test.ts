import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { idTime } from "../chats/format"
import { headerOf } from "../discord/fake-discord.testing"
import { SERVER } from "../discord/objects.testing"
import { writeTargets } from "../targets"
import { attachPath, createFilePostFixture, FILE_TEXT, type FilePostFixture } from "./file-post.testing"
import { discordFilePost } from "./file-post-tool"
import { POST_CREATED_NOTE } from "./post"
import { BUG, IDEA, NEW_POST, postObject, postPath, starterObject, STRICT_FORUM, TAGGED_FORUM } from "./post.testing"
import { NAME } from "./threads.testing"

let f: FilePostFixture

beforeEach(async () => {
  f = await createFilePostFixture()
  await f.files.write("work/a.txt", "hello")
  await f.files.write("work/notes/b.md", "world!")
})

afterEach(() => f.dispose())

const call = (extra: Record<string, unknown> = {}) =>
  f.postFiles({ channel: TAGGED_FORUM, name: NAME, files: ["a.txt", "notes/b.md"], ...extra })
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

describe("a post with files", () => {
  test("reserves in the forum, uploads the copies, then makes the one post naming them, with the text", async () => {
    const result = await call({ text: FILE_TEXT })

    expect(f.sequence()).toEqual([
      `POST ${attachPath()}`,
      "PUT /up/0/file.bin",
      "PUT /up/1/file.bin",
      `POST ${postPath()}`,
    ])
    const [reservation] = f.reservations()
    expect(JSON.parse(reservation!.body!)).toEqual({
      files: [
        { id: "0", filename: "a.txt", file_size: 5 },
        { id: "1", filename: "b.md", file_size: 6 },
      ],
    })
    expect(headerOf(reservation!, "referer")).toContain(`/channels/${SERVER}/${TAGGED_FORUM}`)
    expect(f.puts().map((request) => text(request.bytes))).toEqual(["hello", "world!"])
    expect(f.puts().every((request) => headerOf(request, "authorization") === undefined)).toBe(true)
    expect(f.posted()).toEqual([
      {
        name: NAME,
        applied_tags: [],
        message: {
          content: FILE_TEXT,
          flags: 0,
          allowed_mentions: { parse: ["users"], replied_user: false },
          attachments: [
            { id: "0", filename: "a.txt", uploaded_filename: "uploads/0/stored.bin" },
            { id: "1", filename: "b.md", uploaded_filename: "uploads/1/stored.bin" },
          ],
        },
      },
    ])
    expect(headerOf(f.writes().at(-1)!, "referer")).toContain(`/channels/${SERVER}/${TAGGED_FORUM}`)
    expect(result).toEqual({
      id: NEW_POST,
      channel: TAGGED_FORUM,
      server: SERVER,
      name: NAME,
      tags: [BUG],
      message: NEW_POST,
      sent_at: idTime(NEW_POST),
      silent: false,
      note: POST_CREATED_NOTE,
      files: [
        { name: "a.txt", size: 5 },
        { name: "b.md", size: 6 },
      ],
    })
    expect(f.reads()).toEqual([])
    expect(await f.staged()).toEqual([])
  })

  test("sends files alone with no content, since the text is optional", async () => {
    await call()
    const [post] = f.posted()
    expect(post!.message).not.toHaveProperty("content")
    expect(post!.message).toMatchObject({ attachments: [{ filename: "a.txt" }, { filename: "b.md" }] })
  })

  test("sends the text exactly as given", async () => {
    const given = "  @everyone <@&123> kept  \n\n"
    await call({ text: given })
    expect(f.posted()[0]!.message).toMatchObject({ content: given })
  })

  test("carries the tags, silent and mass mentions as a post does", async () => {
    await call({ tags: [IDEA, BUG], silent: true, mass_mentions: true })
    expect(f.posted()[0]).toMatchObject({
      applied_tags: [IDEA, BUG],
      message: { flags: 4096, allowed_mentions: { parse: ["users", "roles", "everyone"], replied_user: false } },
    })
  })

  test("stores the post and its first message, and marks nothing current", async () => {
    await call({ text: FILE_TEXT })
    expect(f.row(NEW_POST)).toMatchObject({ type: 11, name: NAME, parent: TAGGED_FORUM })
    expect(f.message(NEW_POST)).toMatchObject({ channel: NEW_POST, from_me: 1 })
    expect(f.isCurrent(NEW_POST)).toBe(false)
    expect(f.isCurrent(TAGGED_FORUM)).toBe(false)
  })

  test("goes to a forum that requires a tag when one is given, reserving in that forum", async () => {
    f.serveUploads(STRICT_FORUM)
    f.discord.route("POST", postPath(STRICT_FORUM), {
      status: 200,
      json: { ...postObject(NEW_POST, STRICT_FORUM), message: starterObject() },
    })
    await call({ channel: STRICT_FORUM, tags: [BUG] })
    expect(f.reservations(STRICT_FORUM)).toHaveLength(1)
    expect(f.reservations()).toHaveLength(0)
    expect(f.posted(STRICT_FORUM)).toHaveLength(1)
  })

  test("sends from the working directory by default and from the folders send_dirs names", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    await f.postFiles(
      { channel: TAGGED_FORUM, name: NAME, files: [outside, "a.txt"] },
      { sendDirs: [f.files.other, f.files.work] },
    )
    expect(
      f
        .puts()
        .map((request) => text(request.bytes))
        .slice(-2),
    ).toEqual(["elsewhere", "hello"])
  })

  test("sends a file of exactly the cap", async () => {
    await f.files.write("work/big.txt", "a".repeat(1024 * 1024))
    const result = await f.postFiles({ channel: TAGGED_FORUM, name: NAME, files: ["big.txt"] }, { sendMaxMb: 1 })
    expect(result.files).toEqual([{ name: "big.txt", size: 1024 * 1024 }])
  })
})

describe("the tool's targets", () => {
  test("name the label and the forum, as a post does", async () => {
    expect(await writeTargets(discordFilePost, { channel: TAGGED_FORUM, name: NAME, files: ["a.txt"] }, f.ctx)).toEqual(
      [`default/channel/${TAGGED_FORUM}`],
    )
  })
})
