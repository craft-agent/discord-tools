import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import { ALICE, SERVER } from "../discord/objects.testing"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { type AssignFixture, createAssignFixture } from "./assign.testing"
import { discordRoleAssign, discordRoleUnassign } from "./assign-tool"
import { HELPER, MOD, TIE_A } from "./roles.testing"
import { ROLE_TRANSLATIONS } from "./words"

const ja = translator(ROLE_TRANSLATIONS, "ja")

let f: AssignFixture

beforeEach(async () => {
  f = await createAssignFixture({ held: [MOD, HELPER] })
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

describe("ROLE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the role write tools write, except the chat's", async () => {
    const owned = new Set(Object.keys(CHAT_TRANSLATIONS.ja!))
    const words = [discordRoleAssign, discordRoleUnassign].flatMap((spec) => [spec.title, spec.intent!])
    const target = { server: SERVER, role: TIE_A }
    for (const extra of [{}, { role: HELPER, reason: "why" }]) {
      words.push(
        ...wordsOf((await callDescription(discordRoleAssign, { ...target, users: [ALICE], ...extra }, f.ctx))!),
      )
      words.push(...wordsOf((await callDescription(discordRoleUnassign, { ...target, user: ALICE, ...extra }, f.ctx))!))
    }
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(ROLE_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholders of the headline templates, and translates the titles and the intents", () => {
    expect(ja.template("About to give {role} to {members}")).toBe("{members} に {role} を付与しようとしています")
    expect(ja.template("About to take {role} from {member}")).toBe("{member} から {role} を外そうとしています")
    for (const spec of [discordRoleAssign, discordRoleUnassign]) {
      expect(ja.word(spec.title)).not.toBe(spec.title)
      expect(ja.word(spec.intent!)).not.toBe(spec.intent!)
    }
    for (const label of ["Role", "Members", "Strong permissions", "Reason"]) {
      expect(ja.word(label)).not.toBe(label)
    }
  })
})
