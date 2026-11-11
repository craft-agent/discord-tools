import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription, MAX_VALUE_TEMPLATE_LENGTH } from "../describe"
import { CHANNEL, msgId } from "../discord/objects.testing"
import { THREAD } from "../search/search.testing"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { discordExportCreate } from "./export-tool"
import { createExportFixture, type ExportFixture } from "./export-tool.testing"
import { HISTORY_TRANSLATIONS } from "./words"

const ja = translator(HISTORY_TRANSLATIONS, "ja")

let f: ExportFixture
beforeEach(async () => {
  f = await createExportFixture()
})
afterEach(() => f.dispose())

/** The English words a description writes: the headline, the fact labels and the value templates. */
function wordsOf(description: CallDescription): string[] {
  return [
    ...(description.headline ? [description.headline.text] : []),
    ...description.facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
  ]
}

describe("HISTORY_TRANSLATIONS", () => {
  test("has a Japanese word for every word the export tool writes, except the chat's", async () => {
    const owned = new Set(Object.keys(CHAT_TRANSLATIONS.ja!))
    const words = [discordExportCreate.title, discordExportCreate.intent!]
    const calls = [
      { chat: THREAD },
      { format: "json" },
      { format: "jsonl" },
      { limit: 5 },
      { before: "2026-01-02" },
      { after: msgId(1) },
      { after: msgId(1), before: msgId(5) },
    ]
    for (const extra of calls) {
      words.push(...wordsOf((await callDescription(discordExportCreate, { chat: CHANNEL, ...extra }, f.ctx))!))
    }
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(HISTORY_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("translates the title, the intent and the headline, keeping its placeholder", () => {
    expect(ja.word(discordExportCreate.title)).not.toBe(discordExportCreate.title)
    expect(ja.word(discordExportCreate.intent!)).not.toBe(discordExportCreate.intent!)
    expect(ja.template("About to export {chat}")).toBe("{chat} を書き出そうとしています")
  })

  test.each([
    "The newest {count}",
    "The newest {count}, before {before}",
    "The first {count} after {after}",
    "The first {count} after {after}, before {before}",
  ])("translates the value template %s with its placeholders", (english) => {
    const translated = ja.template(english, MAX_VALUE_TEMPLATE_LENGTH)
    expect(translated).not.toBe(english)
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    expect(names(translated)).toEqual(names(english))
  })
})
