import { describe, expect, test } from "bun:test"
import { ingestMessages, ingestServers } from "../discord/ingest"
import { ALICE, CHANNEL, DM, messageObject, msgId, SERVER, serverObject, userObject } from "../discord/objects.testing"
import { callDescription } from "../describe"
import { discordMessageSend } from "./send-tool"
import { createSendFixture } from "./send.testing"
import { lengthFact } from "./describe"

const REPLY = msgId(1)
const BARE = msgId(50)
const SERVER_FACT = { label: "Server", value: "Test server" }
const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }
const lengthOf = (count: number) => lengthFact("x".repeat(count))

async function createFixture() {
  const f = await createSendFixture()
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
  return f
}

describe("discord_message_send description", () => {
  test("describes a plain send with the chat, the length and the text", async () => {
    const f = await createFixture()
    const description = await callDescription(discordMessageSend, { channel: CHANNEL, text: "Hello" }, f.ctx)
    expect(description).toEqual({
      headline: { text: "About to send a message to {chat}", values: { chat: "#general" } },
      facts: [CHAT_FACT, SERVER_FACT, lengthOf(5)],
      text: { label: "Message text", body: "Hello" },
    })
  })

  test("names the person replied to and quotes the message", async () => {
    const f = await createFixture()
    const description = await callDescription(
      discordMessageSend,
      { channel: CHANNEL, text: "Hi", reply_to: REPLY },
      f.ctx,
    )
    expect(description?.headline).toEqual({
      text: "About to reply to {author} in {chat}",
      values: { author: "Alice", chat: "#general" },
    })
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Reply to", value: "hello there" },
      lengthOf(2),
    ])
  })

  test("replies without an author when the mirror names none", async () => {
    const f = await createFixture()
    const description = await callDescription(
      discordMessageSend,
      { channel: CHANNEL, text: "Hi", reply_to: BARE },
      f.ctx,
    )
    expect(description?.headline).toEqual({ text: "About to reply in {chat}", values: { chat: "#general" } })
  })

  test("adds the mass mention and notification facts before the length", async () => {
    const f = await createFixture()
    const description = await callDescription(
      discordMessageSend,
      { channel: CHANNEL, text: "x", silent: true, mass_mentions: true },
      f.ctx,
    )
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Mass mentions", value: { text: "Notify" } },
      { label: "Notifications", value: { text: "Silent" } },
      lengthOf(1),
    ])
  })

  test("describes a DM by the other person and counts code points", async () => {
    const f = await createFixture()
    const description = await callDescription(discordMessageSend, { channel: DM, text: "😀😀" }, f.ctx)
    expect(description?.headline?.values).toEqual({ chat: "Alice" })
    expect(description?.facts).toEqual([{ label: "Chat", value: { text: "Direct message" } }, lengthOf(2)])
  })

  test("gives no description for a chat or a reply the mirror lacks", async () => {
    const f = await createFixture()
    const unknown = [
      { channel: "1400000000000000999", text: "Hi" },
      { channel: CHANNEL, text: "Hi", reply_to: msgId(999) },
    ]
    for (const args of unknown) expect(await callDescription(discordMessageSend, args, f.ctx)).toBeUndefined()
  })

  test("gives the same answer twice and sends no request", async () => {
    const f = await createFixture()
    const args = { channel: CHANNEL, text: "Hello", reply_to: REPLY }
    const first = await callDescription(discordMessageSend, args, f.ctx)
    expect(await callDescription(discordMessageSend, args, f.ctx)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })
})
