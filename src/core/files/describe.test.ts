import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { callDescription } from "../describe"
import { CHANNEL, SERVER, msgId } from "../discord/objects.testing"
import { describeSave } from "./describe"
import { attachment, createFilesFixture, saveArgs, type FilesFixture } from "./files.testing"
import { discordFileSave } from "./save-tool"

const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
  f.carry({ content: "look at these", attachments: [attachment("a.png"), attachment("notes.txt")] })
})

afterEach(() => f.dispose())

const describeArgs = (extra: Record<string, unknown> = {}) => callDescription(discordFileSave, saveArgs(extra), f.ctx)

describe("discord_file_save description", () => {
  test("names the chat, shows who wrote the message and how it starts, and lists the attachments as the text", async () => {
    expect(await describeArgs()).toEqual({
      headline: { text: "About to save files from {chat}", values: { chat: "#general" } },
      facts: [
        CHAT_FACT,
        SERVER_FACT,
        { label: "Author", value: expect.any(String) },
        { label: "Message", value: "look at these" },
      ],
      text: { label: "Attachments", body: "a.png\nnotes.txt" },
    })
  })

  test("adds Unpack: Every archive when asked to unpack", async () => {
    const description = await describeArgs({ unpack: true })
    expect(description?.facts.at(-1)).toEqual({ label: "Unpack", value: { text: "Every archive" } })
  })

  test("adds Unpack with the entries as one plain string", async () => {
    const description = await describeArgs({ unpack: true, entries: ["a.txt", "docs/"] })
    expect(description?.facts.at(-1)).toEqual({ label: "Unpack", value: "a.txt, docs/" })
  })

  test("has no Unpack fact when not unpacking", async () => {
    const description = await describeArgs({ unpack: false })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Server", "Author", "Message"])
  })

  test("has no text when the mirror holds no attachments", async () => {
    f.carry({ content: "words only" })
    expect(await describeArgs()).not.toHaveProperty("text")
  })

  test("leaves out an attachment the mirror has no name for", async () => {
    f.carry({ attachments: [attachment("a.png", { filename: null }), attachment("b.png")] })
    expect((await describeArgs())?.text?.body).toBe("b.png")
  })

  test("is the same twice and sends no request", async () => {
    const first = await describeArgs()
    expect(await describeArgs()).toEqual(first)
    expect(f.discord.api).toEqual([])
    expect(f.media.requests).toEqual([])
  })

  test("is not_found for a message or a chat the mirror lacks, and no description is given", async () => {
    for (const args of [
      { channel: CHANNEL, message: msgId(99) },
      { channel: "1400000000000000999", message: msgId(99) },
    ]) {
      expect(await failure(describeSave(args, f.ctx))).toMatchObject({ code: "not_found" })
      expect(await callDescription(discordFileSave, args, f.ctx)).toBeUndefined()
    }
  })
})
