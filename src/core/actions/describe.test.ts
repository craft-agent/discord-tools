import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { QUOTE_LENGTH } from "../chats/describe"
import { ingestMessages } from "../discord/ingest"
import { CHANNEL, messageObject, msgId, SERVER, userObject, ME } from "../discord/objects.testing"
import { callDescription } from "../describe"
import { lengthFact } from "../sends/describe"
import type { CallHeadline, ToolSpec } from "../tool"
import { createActionsFixture, OWN, OWN_TEXT, THEIRS } from "./actions.testing"
import { messageFacts, textHash } from "./describe"
import { discordMessageDelete } from "./delete-tool"
import { discordMessageEdit } from "./edit-tool"
import { discordPinAdd, discordPinRemove } from "./pin-tool"
import { discordReactionAdd, discordReactionRemove } from "./reaction-tool"

const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

describe("discord_message_edit description", () => {
  test("describes an edit with the chat, the current text, the length, the new text and a pin", async () => {
    const f = await createActionsFixture()
    const description = await callDescription(
      discordMessageEdit,
      { channel: CHANNEL, message: OWN, text: "new" },
      f.ctx,
    )
    expect(description).toEqual({
      headline: { text: "About to edit your message in {chat}", values: { chat: "#general" } },
      facts: [CHAT_FACT, SERVER_FACT, { label: "Current text", value: OWN_TEXT }, lengthFact("new")],
      text: { label: "New text", body: "new" },
      pins: { current_text: sha256(OWN_TEXT) },
    })
  })

  test("adds the mass mention fact before the length", async () => {
    const f = await createActionsFixture()
    const description = await callDescription(
      discordMessageEdit,
      { channel: CHANNEL, message: OWN, text: "x", mass_mentions: true },
      f.ctx,
    )
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Current text", value: OWN_TEXT },
      { label: "Mass mentions", value: { text: "Notify" } },
      lengthFact("x"),
    ])
  })

  test("pins the whole stored text, so a change past the quoted part still changes the pin", async () => {
    const f = await createActionsFixture()
    const args = { channel: CHANNEL, message: OWN, text: "new" }
    const store = (content: string) =>
      f.seed((m) =>
        ingestMessages(m, f.ingestContext(), [messageObject(OWN, CHANNEL, { author: userObject(ME), content })], {
          reactions: true,
        }),
      )
    const head = "a".repeat(QUOTE_LENGTH)
    store(`${head}one`)
    const first = await callDescription(discordMessageEdit, args, f.ctx)
    store(`${head}two`)
    const second = await callDescription(discordMessageEdit, args, f.ctx)
    expect(second?.facts).toEqual(first?.facts)
    expect(second?.pins).not.toEqual(first?.pins)
    store("other")
    const third = await callDescription(discordMessageEdit, args, f.ctx)
    expect(third?.pins).toEqual({ current_text: sha256("other") })
  })

  test("gives no description for a message or a chat the mirror lacks", async () => {
    const f = await createActionsFixture()
    const unknown = [
      { channel: CHANNEL, message: msgId(999), text: "x" },
      { channel: "1400000000000000999", message: OWN, text: "x" },
    ]
    for (const args of unknown) expect(await callDescription(discordMessageEdit, args, f.ctx)).toBeUndefined()
  })

  test("gives the same answer twice and sends no request", async () => {
    const f = await createActionsFixture()
    const args = { channel: CHANNEL, message: OWN, text: "new" }
    const first = await callDescription(discordMessageEdit, args, f.ctx)
    expect(await callDescription(discordMessageEdit, args, f.ctx)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })
})

describe("discord_message_delete description", () => {
  test("describes a delete with the chat and the whole text, not quoted", async () => {
    const f = await createActionsFixture()
    const content = `first line\n${"b".repeat(QUOTE_LENGTH + 20)}`
    f.seed((m) =>
      ingestMessages(m, f.ingestContext(), [messageObject(OWN, CHANNEL, { author: userObject(ME), content })], {
        reactions: true,
      }),
    )
    const description = await callDescription(discordMessageDelete, { channel: CHANNEL, message: OWN }, f.ctx)
    expect(description).toEqual({
      headline: { text: "About to delete your message in {chat}", values: { chat: "#general" } },
      facts: [CHAT_FACT, SERVER_FACT],
      text: { label: "Message to delete", body: content },
    })
  })

  test("gives no description for a message the mirror lacks, and sends no request", async () => {
    const f = await createActionsFixture()
    const args = { channel: CHANNEL, message: msgId(999) }
    expect(await callDescription(discordMessageDelete, args, f.ctx)).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})

const ON_MESSAGE: [string, ToolSpec, Record<string, unknown>, CallHeadline][] = [
  [
    "discord_reaction_add",
    discordReactionAdd,
    { emoji: "👍" },
    { text: "About to react with {emoji} in {chat}", values: { emoji: "👍", chat: "#general" } },
  ],
  [
    "discord_reaction_remove",
    discordReactionRemove,
    { emoji: "party:1400000000000000050" },
    { text: "About to remove your {emoji} reaction in {chat}", values: { emoji: ":party:", chat: "#general" } },
  ],
  ["discord_pin_add", discordPinAdd, {}, { text: "About to pin a message in {chat}", values: { chat: "#general" } }],
  [
    "discord_pin_remove",
    discordPinRemove,
    {},
    { text: "About to unpin a message in {chat}", values: { chat: "#general" } },
  ],
]

describe.each(ON_MESSAGE)("%s description", (_id, spec, extra, headline) => {
  test("names the chat and shows the author and start of the message, without text or pins", async () => {
    const f = await createActionsFixture()
    const own = await callDescription(spec, { channel: CHANNEL, message: OWN, ...extra }, f.ctx)
    expect(own).toEqual({
      headline,
      facts: [
        CHAT_FACT,
        SERVER_FACT,
        { label: "Author", value: { text: "You" } },
        { label: "Message", value: OWN_TEXT },
      ],
    })
    const theirs = await callDescription(spec, { channel: CHANNEL, message: THEIRS, ...extra }, f.ctx)
    expect(theirs?.facts.slice(0, 3)).toEqual([CHAT_FACT, SERVER_FACT, { label: "Author", value: expect.any(String) }])
    expect(theirs).not.toHaveProperty("text")
    expect(theirs).not.toHaveProperty("pins")
  })

  test("gives no description for a message the mirror lacks, and sends no request", async () => {
    const f = await createActionsFixture()
    const args = { channel: CHANNEL, message: msgId(999), ...extra }
    expect(await callDescription(spec, args, f.ctx)).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})

describe("messageFacts", () => {
  test("names your own message as You", () => {
    expect(messageFacts({ author: "Me", content: "hi", fromMe: true })).toEqual([
      { label: "Author", value: { text: "You" } },
      { label: "Message", value: "hi" },
    ])
  })

  test("names someone else's message by its author", () => {
    expect(messageFacts({ author: "Alice", content: "hi", fromMe: false })[0]).toEqual({
      label: "Author",
      value: "Alice",
    })
  })

  test("leaves out the author the mirror has no name for", () => {
    expect(messageFacts({ author: null, content: "hi", fromMe: false })).toEqual([{ label: "Message", value: "hi" }])
  })

  test("leaves out the quote of an empty message", () => {
    expect(messageFacts({ author: "Alice", content: " \n ", fromMe: false })).toEqual([
      { label: "Author", value: "Alice" },
    ])
  })

  test("quotes a long or multiline message on one line", () => {
    const [, long] = messageFacts({ author: null, content: "a".repeat(QUOTE_LENGTH + 20), fromMe: true })
    expect(long?.value).toBe(`${"a".repeat(QUOTE_LENGTH)}…`)
    expect(messageFacts({ author: null, content: "a\n\n b", fromMe: false })).toEqual([
      { label: "Message", value: "a b" },
    ])
  })
})

describe("textHash", () => {
  test("is the SHA-256 of the UTF-8 text in hex", () => {
    expect(textHash("héllo")).toBe(sha256("héllo"))
  })
})
