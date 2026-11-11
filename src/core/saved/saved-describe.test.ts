import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ACTION_TRANSLATIONS } from "../actions/words"
import { OWN, OWN_TEXT, THEIRS } from "../actions/actions.testing"
import { CHAT_TRANSLATIONS, QUOTE_LENGTH } from "../chats/describe"
import { callDescription } from "../describe"
import { ingestMessages } from "../discord/ingest"
import { CHANNEL, messageObject, msgId, SERVER } from "../discord/objects.testing"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { discordSavedAdd, discordSavedRemove } from "./saved-tool"
import { createSavedFixture, type SavedFixture } from "./saved.testing"
import { SAVED_TRANSLATIONS } from "./words"

let f: SavedFixture

beforeEach(async () => {
  f = await createSavedFixture()
})

afterEach(() => f.dispose())

const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const UNNAMED = msgId(40)
const target = (message = THEIRS) => ({ channel: CHANNEL, message })
const addTo = (args: Record<string, unknown>) => callDescription(discordSavedAdd, args, f.ctx)
const removeFrom = (args: Record<string, unknown>) => callDescription(discordSavedRemove, args, f.ctx)

/** Stores a message of an author the mirror has no name for, with this text. */
function seedUnnamed(content = "who wrote this") {
  const message = messageObject(UNNAMED, CHANNEL, { author: { id: "1400000000000000555" }, content })
  f.seed((m) => ingestMessages(m, f.ingestContext(), [message], { reactions: true }))
}

describe("discord_saved_add description", () => {
  test("names the author and the chat, and shows the reminder in UTC and the start of the message", async () => {
    const description = await addTo({ ...target(), remind_at: "2030-01-01T09:30:00+09:00" })
    expect(description).toEqual({
      headline: {
        text: "About to save a message by {author} in {chat}",
        values: { author: "user02", chat: "#general" },
      },
      facts: [
        CHAT_FACT,
        SERVER_FACT,
        { label: "Reminder", value: "2030-01-01T00:30:00.000Z" },
        { label: "Message", value: "text 002" },
      ],
    })
  })

  test("says the reminder is none when none is asked for", async () => {
    const description = await addTo({ channel: CHANNEL, message: OWN })
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Reminder", value: { text: "none" } },
      { label: "Message", value: OWN_TEXT },
    ])
    expect(description?.headline?.values).toEqual({ author: "user01", chat: "#general" })
  })

  test("uses the headline without an author when the mirror has no name for it", async () => {
    seedUnnamed()
    const description = await addTo(target(UNNAMED))
    expect(description?.headline).toEqual({ text: "About to save a message in {chat}", values: { chat: "#general" } })
    expect(description?.facts).toContainEqual({ label: "Message", value: "who wrote this" })
  })

  test("quotes a long or multiline message short on one line, and leaves out an empty one", async () => {
    seedUnnamed(`a\n\n${"b".repeat(QUOTE_LENGTH + 20)}`)
    const long = await addTo(target(UNNAMED))
    expect(long?.facts.at(-1)).toEqual({ label: "Message", value: `a ${"b".repeat(QUOTE_LENGTH - 2)}…` })
    seedUnnamed(" \n ")
    expect((await addTo(target(UNNAMED)))?.facts.map(({ label }) => label)).toEqual(["Chat", "Server", "Reminder"])
  })

  test("carries no text and no pins", async () => {
    const description = await addTo(target())
    expect(description).not.toHaveProperty("text")
    expect(description).not.toHaveProperty("pins")
  })

  test("gives no description for a message or a chat the mirror lacks, or a reminder that is not a time", async () => {
    for (const args of [
      { channel: CHANNEL, message: msgId(999) },
      { channel: "1400000000000000999", message: OWN },
      { ...target(), remind_at: "tomorrow" },
    ]) {
      expect(await addTo(args)).toBeUndefined()
    }
  })

  test("gives the same answer twice and sends no request", async () => {
    const args = { ...target(), remind_at: "2030-01-01T00:00:00Z" }
    const first = await addTo(args)
    expect(await addTo(args)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })
})

describe("discord_saved_remove description", () => {
  test("names the author and the chat, and shows the start of the message", async () => {
    expect(await removeFrom(target())).toEqual({
      headline: {
        text: "About to remove a saved message by {author} in {chat}",
        values: { author: "user02", chat: "#general" },
      },
      facts: [CHAT_FACT, SERVER_FACT, { label: "Message", value: "text 002" }],
    })
  })

  test("uses the headline without an author when the mirror has no name for it", async () => {
    seedUnnamed()
    expect((await removeFrom(target(UNNAMED)))?.headline).toEqual({
      text: "About to remove a saved message in {chat}",
      values: { chat: "#general" },
    })
  })

  test("gives no description for a message the mirror lacks, and sends no request", async () => {
    expect(await removeFrom({ channel: CHANNEL, message: msgId(999) })).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})

describe("SAVED_TRANSLATIONS", () => {
  const ja = translator(SAVED_TRANSLATIONS, "ja")

  /** The English words a description writes: the headline, the fact labels and value templates, and the text label. */
  const wordsOf = (description: CallDescription | undefined): string[] => [
    ...(description?.headline ? [description.headline.text] : []),
    ...(description?.facts ?? []).flatMap(({ label, value }) => [
      label,
      ...(typeof value === "string" ? [] : [value.text]),
    ]),
  ]

  test("has a Japanese word for every word the saved-message tools write, except the chat's and the actions'", async () => {
    seedUnnamed()
    const words = [
      discordSavedAdd.title,
      discordSavedAdd.intent!,
      discordSavedRemove.title,
      discordSavedRemove.intent!,
      ...wordsOf(await addTo(target())),
      ...wordsOf(await addTo({ ...target(), remind_at: "2030-01-01T00:00:00Z" })),
      ...wordsOf(await addTo(target(UNNAMED))),
      ...wordsOf(await removeFrom(target())),
      ...wordsOf(await removeFrom(target(UNNAMED))),
    ]
    const owned = new Set([...Object.keys(CHAT_TRANSLATIONS.ja!), ...Object.keys(ACTION_TRANSLATIONS.ja!)])
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(SAVED_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholders of the headline templates", () => {
    for (const text of [
      "About to save a message by {author} in {chat}",
      "About to remove a saved message by {author} in {chat}",
    ]) {
      expect(ja.template(text)).toContain("{author}")
      expect(ja.template(text)).toContain("{chat}")
    }
    expect(ja.template("About to save a message in {chat}")).toContain("{chat}")
    expect(ja.template("About to remove a saved message in {chat}")).toContain("{chat}")
  })

  test("translates the titles, the intents, the reminder label and none", () => {
    for (const word of [discordSavedAdd.title, discordSavedRemove.title, "Reminder", "none"]) {
      expect(ja.word(word)).not.toBe(word)
    }
    expect(ja.word(discordSavedAdd.intent!)).not.toBe(discordSavedAdd.intent)
  })
})
