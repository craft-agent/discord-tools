import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { failure } from "../chats/read.testing"
import { ingestMessages, ingestServers } from "../discord/ingest"
import { ALICE, CHANNEL, messageObject, msgId, SERVER, serverObject, userObject } from "../discord/objects.testing"
import { callDescription } from "../describe"
import { lengthFact } from "./describe"
import { createFileSendFixture, type FileSendFixture } from "./file-send.testing"
import { discordFileSend } from "./file-send-tool"

const REPLY = msgId(1)
const BARE = msgId(50)
const SERVER_FACT = { label: "Server", value: "Test server" }
const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }

let f: FileSendFixture

beforeEach(async () => {
  f = await createFileSendFixture()
  f.seed((m) => {
    ingestServers(m, f.ingestContext(), [serverObject(SERVER, { name: "Test server" })])
    ingestMessages(
      m,
      f.ingestContext(),
      [
        messageObject(REPLY, CHANNEL, {
          content: "  hello\n\n  there ",
          author: userObject(ALICE, { global_name: "Alice" }),
        }),
        messageObject(BARE, CHANNEL, { content: "no name", author: { id: "1400000000000000009" } }),
      ],
      { reactions: true },
    )
  })
  await f.files.write("work/a.txt", "first")
})

afterEach(() => f.dispose())

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
const describeCall = (args: Record<string, unknown>, ctx = f.ctx) =>
  callDescription(discordFileSend, { channel: CHANNEL, files: ["a.txt"], ...args }, ctx)

describe("discord_file_send description", () => {
  test("describes a send with the chat, the files, the length, the text and the files' pin", async () => {
    expect(await describeCall({ text: "Hello" })).toEqual({
      headline: { text: "About to send files to {chat}", values: { chat: "#general" } },
      facts: [CHAT_FACT, SERVER_FACT, { label: "Files", value: "a.txt (5 B)" }, lengthFact("Hello")],
      text: { label: "Message text", body: "Hello" },
      pins: { files: sha256("first") },
    })
  })

  test("leaves out the length and the text when only files go", async () => {
    const description = await describeCall({})
    expect(description?.facts).toEqual([CHAT_FACT, SERVER_FACT, { label: "Files", value: "a.txt (5 B)" }])
    expect(description).not.toHaveProperty("text")
  })

  test("lists each file's name and size, in B, KB or MB with one decimal, in the order given", async () => {
    const sizes: [string, number][] = [
      ["b.txt", 1023],
      ["c.txt", 1024],
      ["d.txt", 34 * 1024],
      ["e.txt", 1536],
      ["f.txt", 1024 * 1024 - 1],
      ["g.txt", 1_258_291],
    ]
    for (const [name, size] of sizes) await f.files.write(`work/${name}`, "x".repeat(size))
    const description = await describeCall({ files: sizes.map(([name]) => name) })
    expect(description?.facts[2]).toEqual({
      label: "Files",
      value: "b.txt (1023 B), c.txt (1 KB), d.txt (34 KB), e.txt (1.5 KB), f.txt (1 MB), g.txt (1.2 MB)",
    })
  })

  test("names the file as the send would name it: the real path's base name", async () => {
    await f.files.write("work/notes/report.txt", "r")
    expect((await describeCall({ files: ["notes/../notes/report.txt"] }))?.facts[2]).toEqual({
      label: "Files",
      value: "report.txt (1 B)",
    })
  })

  test("names the person replied to and quotes the message", async () => {
    const description = await describeCall({ reply_to: REPLY })
    expect(description?.headline).toEqual({
      text: "About to reply with files to {author} in {chat}",
      values: { author: "Alice", chat: "#general" },
    })
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Reply to", value: "hello there" },
      { label: "Files", value: "a.txt (5 B)" },
    ])
  })

  test("replies without an author when the mirror names none", async () => {
    const description = await describeCall({ reply_to: BARE })
    expect(description?.headline).toEqual({ text: "About to reply with files in {chat}", values: { chat: "#general" } })
  })

  test("adds the mass mention and notification facts before the files and the length", async () => {
    const description = await describeCall({ text: "x", silent: true, mass_mentions: true })
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Mass mentions", value: { text: "Notify" } },
      { label: "Notifications", value: { text: "Silent" } },
      { label: "Files", value: "a.txt (5 B)" },
      lengthFact("x"),
    ])
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
    await describeCall({ text: "hi" })
    expect(f.untouched()).toBe(true)
    expect(await f.staged()).toEqual([])
  })

  test("gives no description for a chat or a reply the mirror lacks", async () => {
    expect(await describeCall({ channel: "1400000000000000999" })).toBeUndefined()
    expect(await describeCall({ reply_to: msgId(999) })).toBeUndefined()
  })

  test("throws the send's invalid_argument for a file it would refuse, so no description is given", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    await f.files.write("work/empty.txt", "")
    const refused = [[outside], ["missing.txt"], ["empty.txt"], ["a.txt", "a.txt"], Array(11).fill("a.txt")]
    for (const files of refused) {
      const args = { channel: CHANNEL, files }
      expect(await failure(discordFileSend.describe!(args, f.ctx) as Promise<unknown>)).toMatchObject({
        code: "invalid_argument",
      })
      expect(await callDescription(discordFileSend, args, f.ctx)).toBeUndefined()
    }
  })

  test("follows send_dirs and send_max_mb like the send", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    expect((await describeCall({ files: [outside] }, { ...f.ctx, sendDirs: [f.files.other] }))?.facts[2]).toEqual({
      label: "Files",
      value: "o.txt (9 B)",
    })
    await f.files.write("work/big.txt", "a".repeat(1024 * 1024 + 1))
    expect(await describeCall({ files: ["big.txt"] }, { ...f.ctx, sendMaxMb: 1 })).toBeUndefined()
  })
})
