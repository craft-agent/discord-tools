import { describe, expect, test } from "bun:test"
import { ACTION_TRANSLATIONS } from "../actions/words"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import { CHANNEL } from "../discord/objects.testing"
import { SEND_TRANSLATIONS } from "../sends/words"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { discordThreadCreate } from "./create-tool"
import { BUG, createPostsFixture, POST } from "./post.testing"
import { discordPostCreate } from "./post-tool"
import { NAME, SAID } from "./threads.testing"
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
  test("has a Japanese word for every word the thread and post tools write, except the chat's, the actions' and the sends'", async () => {
    const f = await createPostsFixture()
    const owned = new Set([
      ...Object.keys(CHAT_TRANSLATIONS.ja!),
      ...Object.keys(ACTION_TRANSLATIONS.ja!),
      ...Object.keys(SEND_TRANSLATIONS.ja!),
    ])
    const words = [
      discordThreadCreate.title,
      discordThreadCreate.intent!,
      discordPostCreate.title,
      discordPostCreate.intent!,
    ]
    const calls = [
      { channel: CHANNEL, message: SAID },
      { channel: CHANNEL, private: true },
      ...[60, 1440, 4320, 10080].map((auto_archive) => ({ channel: CHANNEL, auto_archive })),
    ]
    for (const call of calls) {
      words.push(...wordsOf((await callDescription(discordThreadCreate, { name: NAME, ...call }, f.ctx))!))
    }
    for (const extra of [{}, { tags: [BUG], silent: true, mass_mentions: true }]) {
      words.push(...wordsOf((await callDescription(discordPostCreate, { ...POST, ...extra }, f.ctx))!))
    }
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(THREAD_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholder of the headline templates, and translates the titles and the intents", () => {
    expect(ja.template("About to start a thread in {chat}")).toBe("{chat} でスレッドを開始しようとしています")
    expect(ja.template("About to post in {chat}")).toBe("{chat} に投稿しようとしています")
    for (const spec of [discordThreadCreate, discordPostCreate]) {
      expect(ja.word(spec.title)).not.toBe(spec.title)
      expect(ja.word(spec.intent!)).not.toBe(spec.intent!)
    }
    expect(ja.word("Tags")).toBe("タグ")
  })
})
