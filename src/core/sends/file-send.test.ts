import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { headerOf } from "../discord/fake-discord.testing"
import { textHash } from "../discord/ingest-sends"
import { CHANNEL, msgId, SERVER } from "../discord/objects.testing"
import { snowflakeTime } from "../discord/snowflake"
import { writeTargets } from "../targets"
import { ATTACH_PATH, answerFileSends, createFileSendFixture, type FileSendFixture } from "./file-send.testing"
import { discordFileSend } from "./file-send-tool"
import { MESSAGES_PATH } from "./send.testing"
import { slotOf } from "./upload.testing"

let f: FileSendFixture

beforeEach(async () => {
  f = await createFileSendFixture()
  answerFileSends(f)
})

afterEach(() => f.dispose())

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

describe("a file send", () => {
  test("reserves, uploads the copies and posts one message naming them, with the text", async () => {
    await f.files.write("work/report.txt", "hello")
    await f.files.write("work/notes/shot.md", "world!")
    const result = await f.sendFiles({ channel: CHANNEL, files: ["report.txt", "notes/shot.md"], text: " see these\n" })

    expect(
      f.discord.requests
        .filter((request) => request.method === "PUT" || request.url.includes("/api/v9"))
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([`POST ${ATTACH_PATH}`, "PUT /up/0/file.bin", "PUT /up/1/file.bin", `POST ${MESSAGES_PATH}`])
    const [reservation] = f.reservations()
    expect(JSON.parse(reservation!.body!)).toEqual({
      files: [
        { id: "0", filename: "report.txt", file_size: 5 },
        { id: "1", filename: "shot.md", file_size: 6 },
      ],
    })
    expect(headerOf(reservation!, "referer")).toContain(`/channels/${SERVER}/${CHANNEL}`)
    expect(f.puts().map((request) => text(request.bytes))).toEqual(["hello", "world!"])
    expect(f.puts().every((request) => headerOf(request, "authorization") === undefined)).toBe(true)

    const [row] = f.ledger()
    expect(f.posted()).toEqual([
      {
        mobile_network_type: "unknown",
        content: " see these\n",
        nonce: row!.nonce,
        tts: false,
        enforce_nonce: true,
        flags: 0,
        allowed_mentions: { parse: ["users"], replied_user: false },
        attachments: [
          { id: "0", filename: "report.txt", uploaded_filename: "uploads/0/stored.bin" },
          { id: "1", filename: "shot.md", uploaded_filename: "uploads/1/stored.bin" },
        ],
      },
    ])
    expect(result).toEqual({
      id: row!.message!,
      channel: CHANNEL,
      sent_at: new Date(snowflakeTime(row!.message!)).toISOString(),
      reply_to: null,
      silent: false,
      note: expect.stringContaining("cannot be unsent"),
      files: [
        { name: "report.txt", size: 5 },
        { name: "shot.md", size: 6 },
      ],
    })
    expect(await f.staged()).toEqual([])
  })

  test("sends files alone with empty content", async () => {
    await f.files.write("work/a.txt", "x")
    await f.sendFiles({ channel: CHANNEL, files: ["a.txt"] })
    expect(f.posted()[0]).toMatchObject({ content: "", attachments: [{ filename: "a.txt" }] })
  })

  test("records the row before anything is requested, hashing the text and each file, and settles it sent", async () => {
    await f.files.write("work/a.txt", "hello")
    let during: unknown
    f.discord.route("POST", ATTACH_PATH, () => {
      during = f.ledger()
      return { status: 200, json: { attachments: [slotOf(0)] } }
    })
    const result = await f.sendFiles({ channel: CHANNEL, files: ["a.txt"], text: "hi" })
    const [row] = f.ledger()
    expect(during).toEqual([{ nonce: row!.nonce, status: "pending", message: null, code: null }])
    expect(row).toEqual({ nonce: row!.nonce, status: "sent", message: result.id, code: null })
    expect(f.inspect((m) => m.prepare("SELECT text_hash FROM sends").get())).toEqual({
      text_hash: textHash(`hi\n${sha256("hello")}`),
    })
  })

  test("stores the message as the account's own, attachments included", async () => {
    await f.files.write("work/a.txt", "hello")
    const { id } = await f.sendFiles({ channel: CHANNEL, files: ["a.txt"], text: "look" })
    expect(f.inspect((m) => m.prepare("SELECT from_me, content FROM messages WHERE id = ?").get(BigInt(id)))).toEqual({
      from_me: 1,
      content: "look",
    })
  })

  test("replies without pinging, silently and with mass mentions when asked", async () => {
    await f.files.write("work/a.txt", "hello")
    const result = await f.sendFiles({
      channel: CHANNEL,
      files: ["a.txt"],
      text: "@here hi",
      silent: true,
      mass_mentions: true,
      reply_to: msgId(2),
    })
    expect(result).toMatchObject({ reply_to: msgId(2), silent: true })
    const body = f.posted()[0] as Record<string, unknown>
    expect(body.flags).toBe(4096)
    expect(body.allowed_mentions).toEqual({ parse: ["users", "roles", "everyone"], replied_user: false })
    expect(body.message_reference).toEqual({
      channel_id: CHANNEL,
      message_id: msgId(2),
      guild_id: SERVER,
      fail_if_not_exists: true,
    })
    const row = f.inspect((m) => m.prepare("SELECT CAST(reply_to AS TEXT) AS reply_to FROM sends").get())
    expect(row).toEqual({ reply_to: msgId(2) })
  })

  test("sends from the working directory by default and from the folders send_dirs names", async () => {
    const outside = await f.files.write("other/o.txt", "elsewhere")
    await f.files.write("work/in.txt", "inside")
    await f.sendFiles({ channel: CHANNEL, files: ["in.txt"] })
    expect(f.posted()).toHaveLength(1)

    await f.sendFiles({ channel: CHANNEL, files: [outside, "in.txt"] }, { sendDirs: [f.files.other, f.files.work] })
    expect(f.posted()).toHaveLength(2)
    expect(
      f
        .puts()
        .map((request) => text(request.bytes))
        .slice(-2),
    ).toEqual(["elsewhere", "inside"])
  })

  test("sends a file of exactly the cap", async () => {
    await f.files.write("work/big.txt", "a".repeat(1024 * 1024))
    const result = await f.sendFiles({ channel: CHANNEL, files: ["big.txt"] }, { sendMaxMb: 1 })
    expect(result.files).toEqual([{ name: "big.txt", size: 1024 * 1024 }])
  })
})

describe("the tool's targets", () => {
  test("name the label and the channel, as the text send does", async () => {
    expect(await writeTargets(discordFileSend, { channel: CHANNEL, files: ["a.txt"] }, f.ctx)).toEqual([
      `default/channel/${CHANNEL}`,
    ])
  })
})
