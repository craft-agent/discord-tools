import { describe, expect, test } from "bun:test"
import { msgId } from "../discord/objects.testing"
import { reactionEmoji } from "./emoji"
import type { ActionMessage } from "./target"

const PARTY = msgId(50)

const message = (reactions: unknown[] | null): ActionMessage => ({
  id: msgId(1),
  fromMe: false,
  type: 0,
  content: "hi",
  reactions: reactions === null ? null : JSON.stringify(reactions),
  pinned: false,
})

const onMessage = message([
  { emoji: "👍", count: 1, me: false },
  { emoji: `party:${PARTY}`, count: 2, me: true },
])

const refusal = (input: string, target = onMessage) => {
  try {
    reactionEmoji(input, target)
  } catch (error) {
    return error
  }
  throw new Error("expected a refusal")
}

describe("a Unicode emoji", () => {
  test.each(["👍", "❤️", "👍🏽", "👨‍👩‍👧", "🇯🇵", "1️⃣", "#️⃣"])("%s is accepted as it is", (emoji) => {
    expect(reactionEmoji(emoji, message(null))).toBe(emoji)
  })

  test.each(["", "a", "1", ":thumbsup:", "👍👍", " 👍", "👍 ", "👍a", "\n"])("%j is refused", (emoji) => {
    expect(refusal(emoji)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("one Unicode emoji"),
    })
  })
})

describe("a custom emoji", () => {
  test.each([`party:${PARTY}`, `<:party:${PARTY}>`, `<a:party:${PARTY}>`, `other:${PARTY}`])(
    "%s is the stored one when the message holds it",
    (emoji) => {
      expect(reactionEmoji(emoji, onMessage)).toBe(`party:${PARTY}`)
    },
  )

  test.each([
    ["is not on the message", `party:${msgId(51)}`, onMessage],
    ["is on a message with no reactions", `party:${PARTY}`, message(null)],
    ["is on a message whose stored reactions are damaged", `party:${PARTY}`, { ...onMessage, reactions: "[1" }],
  ])("one that %s is refused with how to see the reactions", (_, emoji, target) => {
    expect(refusal(emoji, target)).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("discord_chat_read"),
    })
  })

  test("a name with a character a name cannot have is not a custom emoji", () => {
    expect(refusal(`pa rty:${PARTY}`)).toMatchObject({ message: expect.stringContaining("one Unicode emoji") })
  })
})
