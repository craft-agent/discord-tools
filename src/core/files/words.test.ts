import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ACTION_TRANSLATIONS } from "../actions/words"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { attachment, createFilesFixture, saveArgs, type FilesFixture } from "./files.testing"
import { discordFileSave } from "./save-tool"
import { FILE_TRANSLATIONS } from "./words"

const ja = translator(FILE_TRANSLATIONS, "ja")

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
  f.carry({ content: "hi", attachments: [attachment("a.png")] })
})

afterEach(() => f.dispose())

/** The English words a description writes: the headline, the fact labels and value templates, and the text label. */
function wordsOf(description: CallDescription): string[] {
  return [
    ...(description.headline ? [description.headline.text] : []),
    ...description.facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
    ...(description.text ? [description.text.label] : []),
  ]
}

describe("FILE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the save tool writes, except the chat's and the actions'", async () => {
    const owned = new Set([...Object.keys(CHAT_TRANSLATIONS.ja!), ...Object.keys(ACTION_TRANSLATIONS.ja!)])
    const words = [discordFileSave.title, discordFileSave.intent!]
    for (const extra of [{}, { unpack: true }, { unpack: true, entries: ["a.txt"] }]) {
      words.push(...wordsOf((await callDescription(discordFileSave, saveArgs(extra), f.ctx))!))
    }
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(FILE_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholder of the headline template, and translates the title", () => {
    expect(ja.template("About to save files from {chat}")).toBe("{chat} のメッセージのファイルを保存しようとしています")
    expect(ja.word(discordFileSave.title)).not.toBe(discordFileSave.title)
    expect(ja.word(discordFileSave.intent!)).not.toBe(discordFileSave.intent!)
  })
})
