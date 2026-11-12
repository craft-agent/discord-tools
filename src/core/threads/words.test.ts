import { describe, expect, test } from "bun:test"
import { ACTION_TRANSLATIONS } from "../actions/words"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import { CHANNEL } from "../discord/objects.testing"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { discordThreadCreate } from "./create-tool"
import { createThreadsFixture, NAME, SAID } from "./threads.testing"
import { THREAD_TRANSLATIONS } from "./words"

const ja = translator(THREAD_TRANSLATIONS, "ja")

/** The English words a description writes: the headline, the fact labels and value templates, and the text label. */
function wordsOf(description: CallDescription): string[] {
  return [
    ...(description.headline ? [description.headline.text] : []),
    ...description.facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
    ...(description.text ? [description.text.label] : []),
  ]
}

describe("THREAD_TRANSLATIONS", () => {
  test("has a Japanese word for every word the thread tool writes, except the chat's and the actions'", async () => {
    const f = await createThreadsFixture()
    const owned = new Set([...Object.keys(CHAT_TRANSLATIONS.ja!), ...Object.keys(ACTION_TRANSLATIONS.ja!)])
    const words = [discordThreadCreate.title, discordThreadCreate.intent!]
    const calls = [
      { channel: CHANNEL, message: SAID },
      { channel: CHANNEL, private: true },
      ...[60, 1440, 4320, 10080].map((auto_archive) => ({ channel: CHANNEL, auto_archive })),
    ]
    for (const call of calls) {
      words.push(...wordsOf((await callDescription(discordThreadCreate, { name: NAME, ...call }, f.ctx))!))
    }
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(THREAD_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholder of the headline template, and translates the title and the intent", () => {
    expect(ja.template("About to start a thread in {chat}")).toBe("{chat} でスレッドを開始しようとしています")
    expect(ja.word(discordThreadCreate.title)).not.toBe(discordThreadCreate.title)
    expect(ja.word(discordThreadCreate.intent!)).not.toBe(discordThreadCreate.intent!)
  })
})
