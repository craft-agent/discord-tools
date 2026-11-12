import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { failure } from "../chats/read.testing"
import { callDescription } from "../describe"
import { CHANNEL, SERVER } from "../discord/objects.testing"
import { lengthFact } from "../sends/describe"
import { createFilePostFixture, FILE_TEXT, type FilePostFixture } from "./file-post.testing"
import { discordFilePost } from "./file-post-tool"
import { BUG, IDEA, STRANGER, STRICT_FORUM, TAGGED_FORUM } from "./post.testing"
import { MEDIA, NAME } from "./threads.testing"

const HEADLINE = { text: "About to post in {chat}", values: { chat: "#ideas" } }
const CHAT_FACT = { label: "Chat", value: { text: "Channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const NAME_FACT = { label: "Name", value: NAME }
const FILES_FACT = { label: "Files", value: "a.txt (5 B)" }

let f: FilePostFixture

beforeEach(async () => {
  f = await createFilePostFixture()
  await f.files.write("work/a.txt", "first")
})

afterEach(() => f.dispose())

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
const describeCall = (args: Record<string, unknown>, ctx = f.ctx) =>
  callDescription(discordFilePost, { channel: TAGGED_FORUM, name: NAME, files: ["a.txt"], ...args }, ctx)

describe("discord_file_post description", () => {
  test("describes a post with the forum, the name, the files, the length, the text and the files' pin", async () => {
    expect(await describeCall({ text: FILE_TEXT })).toEqual({
      headline: HEADLINE,
      facts: [CHAT_FACT, SERVER_FACT, NAME_FACT, FILES_FACT, lengthFact(FILE_TEXT)],
      text: { label: "Message text", body: FILE_TEXT },
      pins: { files: sha256("first") },
    })
  })

  test("leaves out the length and the text when only files go", async () => {
    const description = await describeCall({})
    expect(description?.facts).toEqual([CHAT_FACT, SERVER_FACT, NAME_FACT, FILES_FACT])
    expect(description).not.toHaveProperty("text")
    expect(description?.pins).toEqual({ files: sha256("first") })
  })

  test("shows the tags, mass mentions and notifications before the files and the length", async () => {
    const description = await describeCall({ text: "x", tags: [IDEA, BUG], silent: true, mass_mentions: true })
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      NAME_FACT,
      { label: "Tags", value: "Idea, Bug" },
      { label: "Mass mentions", value: { text: "Notify" } },
      { label: "Notifications", value: { text: "Silent" } },
      FILES_FACT,
      lengthFact("x"),
    ])
  })

  test("keeps the text as written, including mentions and surrounding space", async () => {
    const text = "  @everyone <@&123>\n\nkept  "
    expect((await describeCall({ text }))?.text).toEqual({ label: "Message text", body: text })
  })

  test("lists each file's name and size as a file send does, in the order given", async () => {
    await f.files.write("work/b.txt", "x".repeat(1536))
    await f.files.write("work/c.txt", "x".repeat(1_258_291))
    expect((await describeCall({ files: ["b.txt", "a.txt", "c.txt"] }))?.facts[3]).toEqual({
      label: "Files",
      value: "b.txt (1.5 KB), a.txt (5 B), c.txt (1.2 MB)",
    })
  })

  test("describes a media channel and a forum that requires a tag given one", async () => {
    expect((await describeCall({ channel: MEDIA }))?.headline).toEqual({
      text: HEADLINE.text,
      values: { chat: "#gallery" },
    })
    expect((await describeCall({ channel: STRICT_FORUM, tags: [BUG] }))?.headline).toEqual({
      text: HEADLINE.text,
      values: { chat: "#rules" },
    })
  })

  test("pins the hash of each file's content, in the order given, so a change changes the pin", async () => {
    await f.files.write("work/b.txt", "second")
    const files = ["a.txt", "b.txt"]
    const first = await describeCall({ files })
    expect(first?.pins).toEqual({ files: `${sha256("first")},${sha256("second")}` })
    expect(await describeCall({ files })).toEqual(first)

    await f.files.write("work/b.txt", "SECOND")
    expect((await describeCall({ files }))?.pins).toEqual({ files: `${sha256("first")},${sha256("SECOND")}` })
    expect((await describeCall({ files: ["b.txt", "a.txt"] }))?.pins).toEqual({
      files: `${sha256("SECOND")},${sha256("first")}`,
    })
  })

  test("sends no request and copies nothing", async () => {
    await describeCall({ text: "hi", tags: [BUG] })
    expect(f.untouched()).toBe(true)
    expect(await f.staged()).toEqual([])
  })
})

describe("a post with files that gives no description", () => {
  test.each([
    ["a channel the mirror lacks", { channel: "1400000000000000999" }],
    ["a text channel", { channel: CHANNEL }],
    ["a tag the forum does not list", { tags: [STRANGER] }],
    ["no tag in a forum that requires one", { channel: STRICT_FORUM }],
    ["a tag given twice", { tags: [BUG, BUG] }],
  ])("%s", async (_, extra) => {
    expect(await describeCall(extra)).toBeUndefined()
    expect(f.untouched()).toBe(true)
  })

  test("throws the send's invalid_argument for a file it would refuse", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    await f.files.write("work/empty.txt", "")
    const refused = [[outside], ["missing.txt"], ["empty.txt"], ["a.txt", "a.txt"], Array(11).fill("a.txt")]
    for (const files of refused) {
      const args = { channel: TAGGED_FORUM, name: NAME, files }
      expect(await failure(discordFilePost.describe!(args, f.ctx) as Promise<unknown>)).toMatchObject({
        code: "invalid_argument",
      })
      expect(await callDescription(discordFilePost, args, f.ctx)).toBeUndefined()
    }
  })

  test("follows send_dirs and send_max_mb like the send", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    expect((await describeCall({ files: [outside] }, { ...f.ctx, sendDirs: [f.files.other] }))?.facts[3]).toEqual({
      label: "Files",
      value: "o.txt (9 B)",
    })
    await f.files.write("work/big.txt", "a".repeat(1024 * 1024 + 1))
    expect(await describeCall({ files: ["big.txt"] }, { ...f.ctx, sendMaxMb: 1 })).toBeUndefined()
  })
})
