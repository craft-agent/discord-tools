import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL, ME, messageObject } from "../discord/objects.testing"
import { discordMessageSend } from "./send-tool"
import { answerSends, createSendFixture, MESSAGES_PATH, ownMessage, type SendFixture } from "./send.testing"

let f: SendFixture

beforeEach(async () => {
  f = await createSendFixture()
})

afterEach(() => f.dispose())

/** Makes the read-back answer with one message that looks like the send and one that does not. */
function serveReadBack(text = "hi") {
  const match = ownMessage(f, CHANNEL, { content: text }, 500)
  const other = ownMessage(f, CHANNEL, { content: "something else" }, 600)
  f.discord.route("GET", MESSAGES_PATH, { status: 200, json: [other, match] })
  return { match, other }
}

const send = (text = "hi") => failure(f.send({ channel: CHANNEL, text }))

describe("a send whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and reports what a read-back saw", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 500, json: { message: "oops" } })
    const { match, other } = serveReadBack()
    const error = await send()
    expect(error).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { nonce: f.posted()[0]!.nonce, matches: [match.id], read_back: "done" },
    })
    expect(f.posted()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
    expect(f.readBacks()[0]!.query.get("limit")).toBe("10")
    expect(f.ledger()).toEqual([{ nonce: f.posted()[0]!.nonce, status: "uncertain", message: null, code: "uncertain" }])
    expect(f.inspect((m) => m.prepare("SELECT 1 FROM messages WHERE id = ?").get(BigInt(other.id)))).toBeDefined()
  })

  test("a failure after the request left is uncertain", async () => {
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    f.discord.route("GET", MESSAGES_PATH, { status: 200, json: [] })
    expect(await send()).toMatchObject({ code: "uncertain", details: { matches: [], read_back: "done" } })
    expect(f.posted()).toHaveLength(1)
    expect(f.ledger()).toMatchObject([{ status: "uncertain" }])
  })

  test.each([
    ["an answer without a message", { status: 200, json: {} }],
    ["an answer that is not JSON", { status: 200, text: "<html>" }],
    [
      "another channel's message",
      { status: 200, json: messageObject("1400000000000000901", "1400000000000000201", { author: { id: ME } }) },
    ],
    ["another author's message", { status: 200, json: messageObject("1400000000000000901", CHANNEL) }],
  ])("%s is uncertain, never a success", async (_, answer) => {
    f.discord.route("POST", MESSAGES_PATH, answer)
    const { match } = serveReadBack()
    expect(await send()).toMatchObject({ code: "uncertain", details: { matches: [match.id] } })
    expect(f.ledger()).toMatchObject([{ status: "uncertain", message: null }])
  })

  test("an answer carrying another nonce is uncertain", async () => {
    answerSends(f, CHANNEL, { nonce: "1" })
    serveReadBack()
    expect(await send()).toMatchObject({ code: "uncertain" })
  })

  test("a failing read-back is reported as failed, with no matches", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 502, json: {} })
    f.discord.route("GET", MESSAGES_PATH, { status: 500, json: {} })
    expect(await send()).toMatchObject({ code: "uncertain", details: { matches: [], read_back: "failed" } })
    expect(f.ledger()).toMatchObject([{ status: "uncertain" }])
    expect(f.readBacks()).toHaveLength(1)
  })

  test("a read-back that is not a list stores nothing and finds nothing", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 500, json: {} })
    f.discord.route("GET", MESSAGES_PATH, { status: 200, json: { message: "odd" } })
    expect(await send()).toMatchObject({ details: { matches: [], read_back: "done" } })
  })

  test("a read-back never matches a different text or a message of someone else", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 500, json: {} })
    const text = "hi "
    f.discord.route("GET", MESSAGES_PATH, {
      status: 200,
      json: [
        ownMessage(f, CHANNEL, { content: "hi" }, 500),
        messageObject("1400000000000000902", CHANNEL, { content: text }),
      ],
    })
    expect(await send(text)).toMatchObject({ details: { matches: [], read_back: "done" } })
  })

  test("a cancelled call is uncertain and skips the read-back", async () => {
    const controller = new AbortController()
    f.discord.route("POST", MESSAGES_PATH, () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordMessageSend
      .execute({ channel: CHANNEL, text: "hi" }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "uncertain", details: { matches: [], read_back: "skipped" } })
    expect(f.ledger()).toMatchObject([{ status: "uncertain" }])
    expect(f.readBacks()).toHaveLength(0)
  })
})
