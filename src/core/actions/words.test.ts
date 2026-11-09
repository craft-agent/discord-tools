import { describe, expect, test } from "bun:test"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import { SEND_TRANSLATIONS } from "../sends/words"
import type { CallDescription, ToolSpec } from "../tool"
import { translator } from "../words"
import { CHANNEL } from "../discord/objects.testing"
import { createActionsFixture, OWN } from "./actions.testing"
import { messageFacts } from "./describe"
import { discordMessageEdit } from "./edit-tool"
import { ACTION_TRANSLATIONS } from "./words"

const ja = translator(ACTION_TRANSLATIONS, "ja")
const TARGET = { channel: CHANNEL, message: OWN }

/** The action tools and the arguments that make them write every word of theirs. */
const TOOLS: [Pick<ToolSpec, "title" | "intent" | "input" | "describe">, Record<string, unknown>[]][] = [
  [
    discordMessageEdit,
    [
      { ...TARGET, text: "x" },
      { ...TARGET, text: "xx", mass_mentions: true },
    ],
  ],
]

/** The English words a description writes: the headline, the fact labels and value templates, and the text label. */
function wordsOf(description: CallDescription): string[] {
  return [
    ...(description.headline ? [description.headline.text] : []),
    ...description.facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
    ...(description.text ? [description.text.label] : []),
  ]
}

describe("ACTION_TRANSLATIONS", () => {
  async function writtenWords(): Promise<string[]> {
    const f = await createActionsFixture()
    const words: string[] = []
    for (const [spec, cases] of TOOLS) {
      words.push(spec.title, spec.intent!)
      for (const args of cases) words.push(...wordsOf((await callDescription(spec, args, f.ctx))!))
    }
    const shared = messageFacts({ author: "Alice", content: "hi", fromMe: true })
    words.push(...wordsOf({ facts: [...shared, ...messageFacts({ author: "Alice", content: "hi", fromMe: false })] }))
    return words
  }

  test("has a Japanese word for every word the action tools write, except the chat's and the send tool's", async () => {
    const owned = new Set([...Object.keys(CHAT_TRANSLATIONS.ja!), ...Object.keys(SEND_TRANSLATIONS.ja!)])
    const own = [...new Set(await writtenWords())].filter((word) => !owned.has(word))
    expect(Object.keys(ACTION_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholders of the headline templates", () => {
    expect(ja.template("About to edit your message in {chat}")).toBe(
      "{chat} の自分のメッセージを編集しようとしています",
    )
    expect(ja.word(discordMessageEdit.title)).not.toBe(discordMessageEdit.title)
  })
})
