import { describe, expect, test } from "bun:test"
import { ingestChannels, ingestDmList, ingestMessages, ingestServers } from "../discord/ingest"
import {
  ALICE,
  BOB,
  CHANNEL,
  channelObject,
  DM,
  messageObject,
  SERVER,
  serverObject,
  userObject,
} from "../discord/objects.testing"
import type { JsonRecord } from "../discord/ingest-values"
import { ToolError } from "../errors"
import type { CallFact } from "../tool"
import { CHAT_TRANSLATIONS, describeChat, mirroredMessage, QUOTE_LENGTH, quote } from "./describe"
import { createChatFixture } from "./read.testing"

const GROUP = "1400000000000000301"
const UNNAMED_GROUP = "1400000000000000302"
const THREAD = "1400000000000000400"
const NAMELESS = "1400000000000000202"
const MESSAGE = "1450000000000000001"
const kind = (text: string): CallFact => ({ label: "Chat", value: { text } })

async function createFixture() {
  const f = await createChatFixture()
  f.seed((m) => {
    const ctx = f.ingestContext()
    ingestServers(m, ctx, [serverObject(SERVER, { name: "Test server" })])
    ingestChannels(
      m,
      ctx,
      [
        channelObject(CHANNEL),
        channelObject(NAMELESS, { name: null }),
        channelObject(THREAD, { type: 11, name: "plans", parent_id: CHANNEL }),
      ],
      SERVER,
    )
    ingestDmList(m, ctx, [
      { id: DM, type: 1, recipients: [userObject(ALICE, { global_name: "Alice" })] },
      { id: GROUP, type: 3, name: "Trip", recipients: [userObject(ALICE), userObject(BOB)] },
      { id: UNNAMED_GROUP, type: 3, recipients: [userObject(ALICE, { global_name: "Alice" }), userObject(BOB)] },
    ])
  })
  return f
}

describe("describeChat", () => {
  test("names a chat as people see it and places it with facts", async () => {
    const f = await createFixture()
    const cases: [string, string, CallFact[]][] = [
      [CHANNEL, "#general", [kind("Text channel"), { label: "Server", value: "Test server" }]],
      [DM, "Alice", [kind("Direct message")]],
      [GROUP, "Trip", [kind("Group DM")]],
      [UNNAMED_GROUP, "Alice, user03", [kind("Group DM")]],
      [
        THREAD,
        "plans",
        [kind("Thread"), { label: "Server", value: "Test server" }, { label: "Channel", value: "#general" }],
      ],
      [NAMELESS, NAMELESS, [kind("Text channel"), { label: "Server", value: "Test server" }]],
    ]
    for (const [channel, name, facts] of cases) {
      expect(
        f.inspect((m) => describeChat(m, channel)),
        channel,
      ).toEqual({ name, facts })
    }
  })

  test("refuses a channel the mirror lacks as not_found", async () => {
    const f = await createFixture()
    const missing = () => f.inspect((m) => describeChat(m, "1400000000000000999"))
    expect(missing).toThrow(ToolError)
    expect(missing).toThrow(/no channel/)
  })

  test("writes only words CHAT_TRANSLATIONS translates", async () => {
    const f = await createFixture()
    const ja = CHAT_TRANSLATIONS.ja!
    for (const channel of [CHANNEL, DM, GROUP, THREAD]) {
      for (const { label, value } of f.inspect((m) => describeChat(m, channel)).facts) {
        expect(ja[label], label).toBeDefined()
        if (typeof value !== "string") expect(ja[value.text], value.text).toBeDefined()
      }
    }
  })
})

describe("quote", () => {
  test("puts whitespace runs on one line and clips at the quote length", () => {
    expect(quote("  a \n\n b\t c  ")).toBe("a b c")
    expect(quote("x".repeat(QUOTE_LENGTH))).toBe("x".repeat(QUOTE_LENGTH))
    expect(quote("x".repeat(QUOTE_LENGTH + 1))).toBe(`${"x".repeat(QUOTE_LENGTH)}…`)
  })
})

describe("mirroredMessage", () => {
  test("names the author by nick, else display name, else username, else nothing", async () => {
    const f = await createFixture()
    const author = (extra: JsonRecord) => ({ author: userObject(ALICE, extra) })
    const cases: [JsonRecord, string | null][] = [
      [{ ...author({ global_name: "Alice" }), member: { nick: "Al" } }, "Al"],
      [author({ global_name: "Alice" }), "Alice"],
      [author({}), "user02"],
      [{ author: { id: "1400000000000000009" } }, null],
    ]
    for (const [index, [extra, expected]] of cases.entries()) {
      const id = String(BigInt(MESSAGE) + BigInt(index))
      f.seed((m) =>
        ingestMessages(m, f.ingestContext(), [messageObject(id, CHANNEL, { content: "hi", ...extra })], {
          reactions: true,
        }),
      )
      expect(f.inspect((m) => mirroredMessage(m, CHANNEL, id))).toEqual({
        author: expected,
        content: "hi",
        fromMe: false,
      })
    }
    expect(f.inspect((m) => mirroredMessage(m, CHANNEL, "1450000000000009999"))).toBeUndefined()
  })
})
