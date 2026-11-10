import { describe, expect, test } from "bun:test"
import { ingestMessages } from "../discord/ingest"
import { ALICE, CHANNEL, messageObject, msgId, userObject } from "../discord/objects.testing"
import { CHAT_TRANSLATIONS } from "../chats/describe"
import { callDescription } from "../describe"
import type { CallDescription } from "../tool"
import { translator } from "../words"
import { createFileSendFixture } from "./file-send.testing"
import { discordFileSend } from "./file-send-tool"
import { FILE_SEND_TRANSLATIONS } from "./file-words"
import { discordMessageSend } from "./send-tool"
import { createSendFixture } from "./send.testing"
import { SEND_TRANSLATIONS } from "./words"

const ja = translator(SEND_TRANSLATIONS, "ja")
const REPLY = msgId(1)
const BARE = msgId(50)

/** The English words a description writes: the headline, the fact labels and value templates, and the text label. */
function wordsOf(description: CallDescription): string[] {
  return [
    description.headline!.text,
    ...description.facts.flatMap(({ label, value }) => [label, ...(typeof value === "string" ? [] : [value.text])]),
    ...(description.text ? [description.text.label] : []),
  ]
}

describe("SEND_TRANSLATIONS", () => {
  async function writtenWords(): Promise<string[]> {
    const f = await createSendFixture()
    f.seed((m) =>
      ingestMessages(
        m,
        f.ingestContext(),
        [
          messageObject(REPLY, CHANNEL, { content: "hi", author: userObject(ALICE, { global_name: "Alice" }) }),
          messageObject(BARE, CHANNEL, { content: "hi", author: { id: "1400000000000000009" } }),
        ],
        { reactions: true },
      ),
    )
    const cases = [
      { text: "x" },
      { text: "xx", reply_to: REPLY },
      { text: "x", reply_to: BARE },
      { text: "x", silent: true },
      { text: "x", mass_mentions: true },
    ]
    const described = await Promise.all(
      cases.map((args) => callDescription(discordMessageSend, { channel: CHANNEL, ...args }, f.ctx)),
    )
    return [discordMessageSend.title, discordMessageSend.intent!, ...described.flatMap((d) => wordsOf(d!))]
  }

  test("has a Japanese word for every word the send tool writes, except the chat's", async () => {
    const chatWords = new Set(Object.keys(CHAT_TRANSLATIONS.ja!))
    const owned = [...new Set(await writtenWords())].filter((word) => !chatWords.has(word))
    expect(Object.keys(SEND_TRANSLATIONS.ja!).sort()).toEqual(owned.sort())
  })

  test("keeps the placeholders of the headline templates", () => {
    expect(ja.template("About to send a message to {chat}")).toBe("{chat} にメッセージを送信しようとしています")
    expect(ja.template("About to reply to {author} in {chat}")).toContain("{author}")
    expect(ja.template("About to reply in {chat}")).toContain("{chat}")
    expect(ja.word(discordMessageSend.title)).not.toBe(discordMessageSend.title)
  })
})

describe("FILE_SEND_TRANSLATIONS", () => {
  const jaFiles = translator(FILE_SEND_TRANSLATIONS, "ja")

  async function writtenWords(): Promise<string[]> {
    const f = await createFileSendFixture()
    try {
      await f.files.write("work/a.txt", "x")
      f.seed((m) =>
        ingestMessages(
          m,
          f.ingestContext(),
          [
            messageObject(REPLY, CHANNEL, { content: "hi", author: userObject(ALICE, { global_name: "Alice" }) }),
            messageObject(BARE, CHANNEL, { content: "hi", author: { id: "1400000000000000009" } }),
          ],
          { reactions: true },
        ),
      )
      const cases = [
        {},
        { text: "xx", reply_to: REPLY },
        { reply_to: BARE },
        { text: "x", silent: true, mass_mentions: true },
      ]
      const described = await Promise.all(
        cases.map((args) => callDescription(discordFileSend, { channel: CHANNEL, files: ["a.txt"], ...args }, f.ctx)),
      )
      return [discordFileSend.title, discordFileSend.intent!, ...described.flatMap((d) => wordsOf(d!))]
    } finally {
      await f.dispose()
    }
  }

  test("has a Japanese word for every word the file send tool writes, except the chat's and the text send's", async () => {
    const owned = new Set([...Object.keys(CHAT_TRANSLATIONS.ja!), ...Object.keys(SEND_TRANSLATIONS.ja!)])
    const own = [...new Set(await writtenWords())].filter((word) => !owned.has(word))
    expect(Object.keys(FILE_SEND_TRANSLATIONS.ja!).sort()).toEqual(own.sort())
  })

  test("keeps the placeholders of the headline templates", () => {
    expect(jaFiles.template("About to send files to {chat}")).toBe("{chat} にファイルを送信しようとしています")
    expect(jaFiles.template("About to reply with files to {author} in {chat}")).toContain("{author}")
    expect(jaFiles.template("About to reply with files in {chat}")).toContain("{chat}")
    expect(jaFiles.word(discordFileSend.title)).not.toBe(discordFileSend.title)
    expect(jaFiles.word(discordFileSend.intent!)).not.toBe(discordFileSend.intent)
  })
})
