import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CATEGORY, FORUM } from "../chats/read.messages.testing"
import { getCursor } from "../discord/mirror-cursors"
import { CHANNEL, DM, ME, msgId, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import { headerOf } from "../discord/fake-discord.testing"
import { snowflakeTime } from "../discord/snowflake"
import { writeTargets } from "../targets"
import { answerSends, createSendFixture, MESSAGES_PATH, ownMessage, type SendFixture } from "./send.testing"
import { discordMessageSend } from "./send-tool"

let f: SendFixture

beforeEach(async () => {
  f = await createSendFixture()
})

afterEach(() => f.dispose())

describe("a send", () => {
  test("posts the body exactly as built and returns the message", async () => {
    answerSends(f)
    const result = await f.send({ channel: CHANNEL, text: " hello @everyone \n" })
    const [row] = f.ledger()
    expect(f.posted()).toEqual([
      {
        mobile_network_type: "unknown",
        content: " hello @everyone \n",
        nonce: row!.nonce,
        tts: false,
        enforce_nonce: true,
        flags: 0,
        allowed_mentions: { parse: ["users"], replied_user: false },
      },
    ])
    expect(result).toEqual({
      id: row!.message!,
      channel: CHANNEL,
      sent_at: new Date(snowflakeTime(row!.message!)).toISOString(),
      reply_to: null,
      silent: false,
      note: expect.stringContaining("cannot be unsent"),
    })
  })

  test("records the nonce before the request leaves and settles it with the message", async () => {
    let during: unknown
    f.discord.route("POST", MESSAGES_PATH, (request) => {
      during = f.ledger()
      const body = JSON.parse(request.body!)
      return {
        status: 200,
        json: { id: "1400000000000000900", channel_id: CHANNEL, author: { id: ME }, content: body.content },
      }
    })
    await f.send({ channel: CHANNEL, text: "hi" })
    const [row] = f.ledger()
    expect(during).toEqual([{ nonce: row!.nonce, status: "pending", message: null, code: null }])
    expect(row).toEqual({ nonce: f.posted()[0]!.nonce, status: "sent", message: "1400000000000000900", code: null })
  })

  test("stores the message as the account's own, without touching the channel's cursor", async () => {
    const before = f.inspect((m) => getCursor(m, CHANNEL))
    answerSends(f)
    const { id } = await f.send({ channel: CHANNEL, text: "hi" })
    expect(f.inspect((m) => m.prepare("SELECT from_me, content FROM messages WHERE id = ?").get(BigInt(id)))).toEqual({
      from_me: 1,
      content: "hi",
    })
    expect(f.inspect((m) => getCursor(m, CHANNEL))).toEqual(before)
    expect(before).toBeDefined()
  })

  test("a message Discord took is reported as sent even when the mirror cannot store it", async () => {
    f.discord.route("POST", MESSAGES_PATH, (request) => {
      f.seed((m) => m.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'full'); END"))
      const body = JSON.parse(request.body!) as { content: string; nonce: string }
      return { status: 200, json: ownMessage(f, CHANNEL, { content: body.content, nonce: body.nonce }) }
    })
    const result = await f.send({ channel: CHANNEL, text: "hi" })
    expect(result.errors).toEqual({ store: expect.stringContaining("full") })
    expect(result.note).toContain("could not store it")
    expect(f.ledger()).toEqual([{ nonce: f.posted()[0]!.nonce, status: "sent", message: result.id, code: null }])
    expect(f.readBacks()).toHaveLength(0)
  })

  test("sends silent and mass mention choices, and replies to a mirrored message", async () => {
    answerSends(f)
    const result = await f.send({
      channel: CHANNEL,
      text: "@here hi",
      silent: true,
      mass_mentions: true,
      reply_to: msgId(2),
    })
    expect(result).toMatchObject({ reply_to: msgId(2), silent: true })
    const body = f.posted()[0]!
    expect(body.flags).toBe(4096)
    expect(body.allowed_mentions).toEqual({ parse: ["users", "roles", "everyone"], replied_user: false })
    expect(body.message_reference).toEqual({
      channel_id: CHANNEL,
      message_id: msgId(2),
      guild_id: SERVER,
      fail_if_not_exists: true,
    })
    const ledgerRow = f.inspect(
      (m) => m.prepare("SELECT CAST(reply_to AS TEXT) AS reply_to FROM sends").get() as { reply_to: string },
    )
    expect(ledgerRow.reply_to).toBe(msgId(2))
  })

  test("names the server channel's page as the referer, and the DM's as @me", async () => {
    answerSends(f)
    answerSends(f, DM)
    await f.send({ channel: CHANNEL, text: "a" })
    await f.send({ channel: DM, text: "b" })
    const referers = f.discord.api.filter((request) => request.method === "POST").map((r) => headerOf(r, "referer"))
    expect(referers).toEqual([
      expect.stringContaining(`/channels/${SERVER}/${CHANNEL}`),
      expect.stringContaining(`/channels/@me/${DM}`),
    ])
    expect(f.posted(DM)[0]!.message_reference).toBeUndefined()
  })
})

describe("a send that is refused before anything leaves", () => {
  const refused = async (args: unknown, code: string) => {
    expect(await failure(f.send(args))).toMatchObject({ code })
    expect(f.discord.api).toHaveLength(0)
    expect(f.ledger()).toEqual([])
  }

  test("an unknown channel is not_found", () => refused({ channel: "1400000000000000999", text: "hi" }, "not_found"))

  test("a category or a forum is invalid_argument", async () => {
    await refused({ channel: CATEGORY, text: "hi" }, "invalid_argument")
    await refused({ channel: FORUM, text: "hi" }, "invalid_argument")
  })

  test("a reply to a message the mirror does not hold is not_found, and says to read the chat", async () => {
    const error = await failure(f.send({ channel: CHANNEL, text: "hi", reply_to: msgId(99) }))
    expect(error).toMatchObject({ code: "not_found", message: expect.stringContaining("discord_chat_read") })
    expect(f.discord.api).toHaveLength(0)
    expect(f.ledger()).toEqual([])
  })

  test("a reply to a message of another channel is not_found", async () => {
    f.seedOwn(msgId(50), "elsewhere")
    f.seed((m) =>
      m.prepare("UPDATE messages SET channel = ? WHERE id = ?").run(BigInt(OTHER_CHANNEL), BigInt(msgId(50))),
    )
    await refused({ channel: CHANNEL, text: "hi", reply_to: msgId(50) }, "not_found")
  })

  test.each([
    ["text of whitespace only", { text: " \n\t " }],
    ["empty text", { text: "" }],
    ["text over 4000 characters", { text: "x".repeat(4001) }],
    ["a channel name", { channel: "general", text: "hi" }],
    ["a reply_to that is not an id", { reply_to: "latest", text: "hi" }],
    ["an unknown argument", { text: "hi", tts: true }],
  ])("%s is invalid_argument", (_, args) => refused({ channel: CHANNEL, ...args }, "invalid_argument"))

  test("text of exactly 4000 characters passes the schema", async () => {
    answerSends(f)
    await f.send({ channel: CHANNEL, text: "x".repeat(4000) })
    expect(f.posted()).toHaveLength(1)
  })
})

describe("a send that Discord refuses", () => {
  test.each([
    [400, "invalid_argument"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ])("a %i is %s, settles the send as not_sent and reads nothing back", async (status, code) => {
    f.discord.route("POST", MESSAGES_PATH, { status, json: { retry_after: 1.5, message: "no" } })
    expect(await failure(f.send({ channel: CHANNEL, text: "hi" }))).toMatchObject({ code })
    expect(f.ledger()).toEqual([{ nonce: f.posted()[0]!.nonce, status: "not_sent", message: null, code }])
    expect(f.discord.api).toHaveLength(1)
  })

  test("a connection never made is upstream_error and not_sent", async () => {
    f.discord.failNext({ dispatched: false })
    expect(await failure(f.send({ channel: CHANNEL, text: "hi" }))).toMatchObject({ code: "upstream_error" })
    expect(f.ledger()).toMatchObject([{ status: "not_sent", code: "upstream_error" }])
    expect(f.discord.api).toHaveLength(1)
  })

  test("a send cancelled before dispatch throws the abort and settles as cancelled", async () => {
    answerSends(f)
    await f.send({ channel: CHANNEL, text: "first" })
    const controller = new AbortController()
    const runtime = f.ctx.runtime!
    const ctx = {
      ...f.ctx,
      signal: controller.signal,
      runtime: {
        ...runtime,
        discord: {
          ...runtime.discord,
          sleep: async (ms: number) => {
            controller.abort()
            f.advance(ms)
          },
        },
      },
    }
    const error = await discordMessageSend.execute({ channel: CHANNEL, text: "second" }, ctx).catch((e: unknown) => e)
    expect(error).toMatchObject({ name: "AbortError" })
    expect(f.posted()).toHaveLength(1)
    const settled = f.ledger().map(({ status, code }) => ({ status, code }))
    expect(settled).toHaveLength(2)
    expect(settled).toContainEqual({ status: "sent", code: null })
    expect(settled).toContainEqual({ status: "not_sent", code: "cancelled" })
  })
})

describe("the tool's targets", () => {
  test("name the label and the channel", async () => {
    expect(await writeTargets(discordMessageSend, { channel: CHANNEL, text: "hi" }, f.ctx)).toEqual([
      `default/channel/${CHANNEL}`,
    ])
  })

  test("fall back to * for an account that does not exist", async () => {
    expect(await writeTargets(discordMessageSend, { account: "nobody", channel: CHANNEL, text: "hi" }, f.ctx)).toEqual([
      "*",
    ])
  })
})
