import { describe, expect, test } from "bun:test"
import { templatePlaceholders } from "./core/describe"
import { translator } from "./core/words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

const ja = translator(ALL_TRANSLATIONS, "ja")
const entries = Object.entries(ALL_TRANSLATIONS.ja!)

describe("ALL_TRANSLATIONS", () => {
  test("keeps the placeholders of every template in its Japanese", () => {
    for (const [english, japanese] of entries) {
      const expected = templatePlaceholders(english)
      expect(templatePlaceholders(japanese), english).toEqual(expected)
    }
  })

  test("has Japanese words for the title and the intent of every write tool that states one", () => {
    const writers = ALL_TOOLS.filter((tool) => tool.class !== "read" && tool.intent !== undefined)
    for (const tool of writers) {
      expect(ja.word(tool.title), tool.id).not.toBe(tool.title)
      expect(ja.word(tool.intent!), tool.id).not.toBe(tool.intent)
    }
  })

  test("holds the shared fact words in Japanese", () => {
    expect(ALL_TRANSLATIONS.ja!.Size).toBe("サイズ")
  })
})
