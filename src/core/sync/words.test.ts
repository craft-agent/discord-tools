import { describe, expect, test } from "bun:test"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import { CHANNEL, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import type { CallDescription, ToolSpec } from "../tool"
import { translator } from "../words"
import { discordSyncAdd } from "./add"
import { createSyncFixture } from "./read.testing"
import { discordSyncRemove } from "./remove"
import { seedGuilds } from "./write.testing"
import { SYNC_TRANSLATIONS } from "./words"

const ja = translator(SYNC_TRANSLATIONS, "ja")

/** The sync tools and the arguments that make them write every word of theirs. */
const TOOLS: [Pick<ToolSpec, "title" | "intent" | "input" | "describe">, Record<string, unknown>[]][] = [
  [
    discordSyncAdd,
    [{ server: SERVER }, { server: SERVER, channels: [CHANNEL] }, { server: SERVER, exclude: [OTHER_CHANNEL] }],
  ],
  [discordSyncRemove, [{ server: SERVER }, { server: SERVER, channels: [CHANNEL] }]],
]

/** The English words a description writes: the headline, and the fact labels and value templates. */
function wordsOf(description: CallDescription): string[] {
  return [
    ...(description.headline ? [description.headline.text] : []),
    ...description.facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
  ]
}

describe("SYNC_TRANSLATIONS", () => {
  test("has a Japanese word for every word the sync tools write, except the chat's", async () => {
    const f = await createSyncFixture()
    seedGuilds(f)
    const words: string[] = []
    for (const [spec, cases] of TOOLS) {
      words.push(spec.title, spec.intent!)
      for (const args of cases) words.push(...wordsOf((await callDescription(spec, args, f.ctx))!))
    }
    const owned = new Set(Object.keys(CHAT_TRANSLATIONS.ja!))
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(SYNC_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the server placeholder of the headline templates", () => {
    for (const text of [
      "About to follow {server}",
      "About to follow channels of {server}",
      "About to stop following {server}",
      "About to stop following channels of {server}",
    ]) {
      expect(ja.template(text), text).toContain("{server}")
    }
  })
})
