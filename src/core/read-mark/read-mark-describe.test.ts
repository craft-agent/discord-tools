import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OWN, OWN_TEXT, THEIRS } from "../actions/actions.testing"
import { ACTION_TRANSLATIONS } from "../actions/words"
import { CHAT_TRANSLATIONS, QUOTE_LENGTH } from "../chats/describe"
import { callDescription } from "../describe"
import { ingestMessages } from "../discord/ingest"
import { CHANNEL, messageObject, msgId, SERVER } from "../discord/objects.testing"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { discordReadMark } from "./read-mark-tool"
import { createReadMarkFixture, EMPTY_CHANNEL, NEWEST, type ReadMarkFixture } from "./read-mark.testing"
import { READ_MARK_TRANSLATIONS } from "./words"

let f: ReadMarkFixture

beforeEach(async () => {
  f = await createReadMarkFixture()
})

afterEach(() => f.dispose())

const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const READ_STATE_FACT = { label: "Read state", value: { text: "cleared on every device up to this message" } }
const UNNAMED = msgId(40)
const describeMark = (args: Record<string, unknown>) => callDescription(discordReadMark, args, f.ctx)

/** Stores a message of an author the mirror has no name for, newer than the rest, with this text. */
function seedUnnamed(content = "who wrote this") {
  const message = messageObject(UNNAMED, CHANNEL, { author: { id: "1400000000000000555" }, content })
  f.seed((m) => ingestMessages(m, f.ingestContext(), [message], { reactions: true }))
}

describe("discord_read_mark description", () => {
  test("names the chat and the author of the message named, and what the mark does to the read state", async () => {
    expect(await describeMark({ channel: CHANNEL, message: THEIRS })).toEqual({
      headline: {
        text: "About to mark {chat} read up to a message by {author}",
        values: { author: "user02", chat: "#general" },
      },
      facts: [CHAT_FACT, SERVER_FACT, { label: "Message", value: "text 002" }, READ_STATE_FACT],
    })
  })

  test("resolves the newest mirrored message when none is named, and pins it", async () => {
    expect(await describeMark({ channel: CHANNEL })).toEqual({
      headline: {
        text: "About to mark {chat} read up to a message by {author}",
        values: { author: "user02", chat: "#general" },
      },
      facts: [CHAT_FACT, SERVER_FACT, { label: "Message", value: "text 012" }, READ_STATE_FACT],
      pins: { message: NEWEST },
    })
  })

  test("pins nothing when the message is named, and shows the user's own message", async () => {
    const description = await describeMark({ channel: CHANNEL, message: OWN })
    expect(description).not.toHaveProperty("pins")
    expect(description?.facts).toContainEqual({ label: "Message", value: OWN_TEXT })
    expect(description?.headline?.values).toEqual({ author: "user01", chat: "#general" })
  })

  test("uses the headline without an author when the mirror has no name for it", async () => {
    seedUnnamed()
    const description = await describeMark({ channel: CHANNEL })
    expect(description?.headline).toEqual({ text: "About to mark {chat} read", values: { chat: "#general" } })
    expect(description?.facts).toContainEqual({ label: "Message", value: "who wrote this" })
    expect(description?.pins).toEqual({ message: UNNAMED })
  })

  test("quotes a long or multiline message short on one line, and leaves out an empty one", async () => {
    seedUnnamed(`a\n\n${"b".repeat(QUOTE_LENGTH + 20)}`)
    expect((await describeMark({ channel: CHANNEL }))?.facts.at(-2)).toEqual({
      label: "Message",
      value: `a ${"b".repeat(QUOTE_LENGTH - 2)}…`,
    })
    seedUnnamed(" \n ")
    expect((await describeMark({ channel: CHANNEL }))?.facts.map(({ label }) => label)).toEqual([
      "Chat",
      "Server",
      "Read state",
    ])
  })

  test("carries no text", async () => {
    expect(await describeMark({ channel: CHANNEL })).not.toHaveProperty("text")
  })

  test("gives no description for a chat or a message the mirror lacks, or a chat with no message", async () => {
    for (const args of [
      { channel: CHANNEL, message: msgId(999) },
      { channel: "1400000000000000999" },
      { channel: "1400000000000000999", message: OWN },
      { channel: EMPTY_CHANNEL },
    ]) {
      expect(await describeMark(args)).toBeUndefined()
    }
  })

  test("gives the same answer twice and sends no request", async () => {
    const first = await describeMark({ channel: CHANNEL })
    expect(await describeMark({ channel: CHANNEL })).toEqual(first)
    expect(f.discord.api).toEqual([])
  })
})

describe("READ_MARK_TRANSLATIONS", () => {
  const ja = translator(READ_MARK_TRANSLATIONS, "ja")

  /** The English words a description writes: the headline, the fact labels and value templates. */
  const wordsOf = (description: CallDescription | undefined): string[] => [
    ...(description?.headline ? [description.headline.text] : []),
    ...(description?.facts ?? []).flatMap(({ label, value }) => [
      label,
      ...(typeof value === "string" ? [] : [value.text]),
    ]),
  ]

  test("has a Japanese word for every word the tool writes, except the chat's and the actions'", async () => {
    const words = [
      discordReadMark.title,
      discordReadMark.intent!,
      ...wordsOf(await describeMark({ channel: CHANNEL, message: THEIRS })),
    ]
    seedUnnamed()
    words.push(...wordsOf(await describeMark({ channel: CHANNEL })))
    const owned = new Set([...Object.keys(CHAT_TRANSLATIONS.ja!), ...Object.keys(ACTION_TRANSLATIONS.ja!)])
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(READ_MARK_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholders of the headline templates", () => {
    expect(ja.template("About to mark {chat} read up to a message by {author}")).toContain("{author}")
    expect(ja.template("About to mark {chat} read up to a message by {author}")).toContain("{chat}")
    expect(ja.template("About to mark {chat} read")).toContain("{chat}")
  })

  test("translates the title, the intent, the read state label and its value", () => {
    for (const word of [
      discordReadMark.title,
      discordReadMark.intent!,
      "Read state",
      "cleared on every device up to this message",
    ]) {
      expect(ja.word(word)).not.toBe(word)
    }
  })
})
