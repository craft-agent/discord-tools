import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { wholeCallDescription } from "../describe"
import { ALICE, SERVER } from "../discord/objects.testing"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { type AssignFixture, createAssignFixture } from "./assign.testing"
import { discordRoleAssign, discordRoleUnassign } from "./assign-tool"
import { discordRoleCreate, discordRoleDelete, discordRoleEdit } from "./manage-tool"
import { HELPER, MOD, TIE_A } from "./roles.testing"
import { ROLE_TRANSLATIONS } from "./words"

const ja = translator(ROLE_TRANSLATIONS, "ja")

const SPECS = [discordRoleAssign, discordRoleUnassign, discordRoleCreate, discordRoleEdit, discordRoleDelete]

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
    const words = SPECS.flatMap((spec) => [spec.title, spec.intent!])
    const target = { server: SERVER, role: TIE_A }
    const appearance = { name: "Tea", hoist: true, mentionable: false, reason: "why" }
    const calls: [(typeof SPECS)[number], object][] = [
      [discordRoleAssign, { ...target, users: [ALICE] }],
      [discordRoleAssign, { ...target, role: HELPER, users: [ALICE], reason: "why" }],
      [discordRoleUnassign, { ...target, user: ALICE }],
      [discordRoleUnassign, { ...target, role: HELPER, user: ALICE, reason: "why" }],
      [discordRoleCreate, { server: SERVER, name: "Tea" }],
      [discordRoleCreate, { server: SERVER, ...appearance, color: "#1abc9c", permissions: ["kick_members"] }],
      [discordRoleEdit, { ...target, ...appearance, color: "none", grant: ["kick_members"], revoke: ["connect"] }],
      [discordRoleDelete, { ...target, reason: "why" }],
    ]
    for (const [spec, args] of calls) words.push(...wordsOf((await wholeCallDescription(spec, args, f.ctx))!))
    const own = [...new Set(words)].filter((word) => !owned.has(word))
    expect(Object.keys(ROLE_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholders of the headline templates, and translates the titles and the intents", () => {
    expect(ja.template("About to give {role} to {members}")).toBe("{members} に {role} を付与しようとしています")
    expect(ja.template("About to take {role} from {member}")).toBe("{member} から {role} を外そうとしています")
    expect(ja.template("About to create the role {name}")).toBe("ロール {name} を作成しようとしています")
    expect(ja.template("About to edit {role}")).toBe("{role} を編集しようとしています")
    expect(ja.template("About to delete {role}")).toBe("{role} を削除しようとしています")
    for (const spec of SPECS) {
      expect(ja.word(spec.title)).not.toBe(spec.title)
      expect(ja.word(spec.intent!)).not.toBe(spec.intent!)
    }
  })

  test("translates the fact labels and the words of their values", () => {
    const labels = ["Role", "Members", "New name", "Color", "Listed apart", "Mentionable", "Permissions", "Grant"]
    for (const label of [...labels, "Revoke", "Strong permissions", "Reason", "Yes", "No", "None"]) {
      expect(ja.word(label)).not.toBe(label)
    }
  })
})
