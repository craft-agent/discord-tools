import { describe, expect, test } from "bun:test"
import { ALICE, CHANNEL, ME, NOW, OTHER_CHANNEL, SERVER, messageObject } from "../discord/objects.testing"
import { isSnowflake, snowflakeAt, snowflakeTime } from "../discord/snowflake"
import { newNonce, readBackMatches, sendBody, sentMessage, SUPPRESS_NOTIFICATIONS } from "./payload"

const NONCE = snowflakeAt(NOW)
const REPLY = { channel: CHANNEL, message: "1400000000000000555", server: SERVER }

/** A message of the account in the test channel, made at `at`. */
const mine = (at: number, extra: Record<string, unknown> = {}) =>
  messageObject(snowflakeAt(at), CHANNEL, { author: { id: ME }, content: "hello", ...extra })

describe("newNonce", () => {
  test("is a snowflake made at the given time", () => {
    const nonce = newNonce(NOW)
    expect(isSnowflake(nonce)).toBe(true)
    expect(snowflakeTime(nonce)).toBe(NOW)
  })

  test("fills the low 22 bits with random bits", () => {
    const nonces = new Set(Array.from({ length: 20 }, () => newNonce(NOW)))
    expect(nonces.size).toBeGreaterThan(1)
    for (const nonce of nonces) {
      expect(BigInt(nonce) - BigInt(snowflakeAt(NOW))).toBeLessThan(2n ** 22n)
    }
  })
})

describe("sendBody", () => {
  const plain = { text: "hi  ", nonce: NONCE, silent: false, massMentions: false }

  test("a plain send notifies users only and keeps the text as given", () => {
    expect(sendBody(plain)).toEqual({
      mobile_network_type: "unknown",
      content: "hi  ",
      nonce: NONCE,
      tts: false,
      enforce_nonce: true,
      flags: 0,
      allowed_mentions: { parse: ["users"], replied_user: false },
    })
  })

  test("a silent send suppresses notifications", () => {
    expect(sendBody({ ...plain, silent: true }).flags).toBe(SUPPRESS_NOTIFICATIONS)
  })

  test("mass mentions add roles and everyone", () => {
    expect(sendBody({ ...plain, massMentions: true }).allowed_mentions).toEqual({
      parse: ["users", "roles", "everyone"],
      replied_user: false,
    })
  })

  test("a reply names the message, fails when it is gone and never pings its author", () => {
    const body = sendBody({ ...plain, reply: REPLY })
    expect(body.message_reference).toEqual({
      channel_id: CHANNEL,
      message_id: REPLY.message,
      guild_id: SERVER,
      fail_if_not_exists: true,
    })
    expect(body.allowed_mentions.replied_user).toBe(false)
  })

  test("carries the attachments of a file send, and none otherwise", () => {
    const attachments = [{ id: "0", filename: "a.txt", uploaded_filename: "uploads/a.txt" }]
    expect(sendBody({ ...plain, text: "", attachments }).attachments).toEqual(attachments)
    expect(sendBody(plain)).not.toHaveProperty("attachments")
  })

  test("a reply in a chat without a server names no guild", () => {
    const body = sendBody({ ...plain, reply: { ...REPLY, server: null } })
    expect(body.message_reference).toEqual({
      channel_id: CHANNEL,
      message_id: REPLY.message,
      fail_if_not_exists: true,
    })
  })
})

describe("sentMessage", () => {
  const expected = { channel: CHANNEL, me: ME, nonce: NONCE }
  const answer = (extra: Record<string, unknown> = {}) =>
    messageObject("1400000000000000900", CHANNEL, { author: { id: ME }, ...extra })

  test("accepts the sent message, with our nonce or none", () => {
    expect(sentMessage(answer({ nonce: NONCE }), expected)).toMatchObject({ id: "1400000000000000900" })
    expect(sentMessage(answer(), expected)).toMatchObject({ id: "1400000000000000900" })
  })

  test.each([
    ["another channel's message", answer({ channel_id: OTHER_CHANNEL })],
    ["another author's message", answer({ author: { id: ALICE } })],
    ["a message without an author", answer({ author: undefined })],
    ["another nonce", answer({ nonce: "1" })],
    ["a message without an id", answer({ id: undefined })],
    ["an id that is not a snowflake", answer({ id: "abc" })],
    ["an empty object", {}],
    ["null", null],
    ["a list", [answer()]],
    ["text", "ok"],
  ])("refuses %s", (_, value) => {
    expect(sentMessage(value, expected)).toBeUndefined()
  })
})

describe("readBackMatches", () => {
  const since = NOW - 2000
  const options = { me: ME, text: "hello", replyTo: undefined, since }

  test("lists the account's messages with the same text since the send, newest first", () => {
    const older = mine(NOW - 1000)
    const newer = mine(NOW + 500)
    expect(readBackMatches([older, newer], options)).toEqual([newer.id, older.id])
  })

  test("compares the text exactly, whitespace included", () => {
    const messages = [
      mine(NOW, { content: "hello " }),
      mine(NOW + 1, { content: "Hello" }),
      mine(NOW + 2, { content: " hello" }),
    ]
    expect(readBackMatches(messages, options)).toEqual([])
  })

  test("ignores other authors and messages before the slack", () => {
    const messages = [mine(NOW, { author: { id: ALICE } }), mine(since - 1), mine(since + 1)]
    expect(readBackMatches(messages, options)).toEqual([messages[2]!.id])
  })

  test("a reply matches only a reply to the same message, a plain send only a plain message", () => {
    const reply = mine(NOW, { message_reference: { message_id: REPLY.message } })
    const elsewhere = mine(NOW + 1, { message_reference: { message_id: "1400000000000000556" } })
    const plain = mine(NOW + 2)
    const messages = [reply, elsewhere, plain]
    expect(readBackMatches(messages, { ...options, replyTo: REPLY.message })).toEqual([reply.id])
    expect(readBackMatches(messages, options)).toEqual([plain.id])
  })

  test("compares the attachment count, not the names, when it is given", () => {
    const file = { id: "1", filename: "renamed.txt" }
    const two = mine(NOW, { attachments: [file, file] })
    const one = mine(NOW + 1, { attachments: [file] })
    const none = mine(NOW + 2)
    const messages = [two, one, none]
    expect(readBackMatches(messages, { ...options, attachments: 2 })).toEqual([two.id])
    expect(readBackMatches(messages, { ...options, attachments: 0 })).toEqual([none.id])
    expect(readBackMatches(messages, options)).toEqual([none.id, one.id, two.id])
  })

  test.each([
    ["null", null],
    ["an object", { id: "1" }],
    ["text", "x"],
    ["undefined", undefined],
  ])("finds nothing in %s", (_, value) => {
    expect(readBackMatches(value, options)).toEqual([])
  })

  test("skips entries that are not messages", () => {
    expect(readBackMatches([null, 3, "x", {}, [], { id: "x", author: { id: ME }, content: "hello" }], options)).toEqual(
      [],
    )
  })
})
