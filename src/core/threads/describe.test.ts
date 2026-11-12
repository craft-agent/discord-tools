import { describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { CHANNEL, msgId, SERVER } from "../discord/objects.testing"
import { ANNOUNCEMENT, createThreadsFixture, NAME, NEWS_MESSAGE, SAID } from "./threads.testing"
import { discordThreadCreate } from "./create-tool"

const HEADLINE = { text: "About to start a thread in {chat}", values: { chat: "#general" } }
const CHAT_FACT = { label: "Chat", value: { text: "Text channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const NAME_FACT = { label: "Name", value: NAME }
const DEFAULTS = [
  { label: "Visibility", value: { text: "Public" } },
  { label: "Archives after", value: { text: "Discord's default" } },
]

describe("discord_thread_create description", () => {
  test("describes a standalone thread with the chat, the name as given, its visibility and its archive time", async () => {
    const f = await createThreadsFixture()
    const description = await callDescription(discordThreadCreate, { channel: CHANNEL, name: NAME }, f.ctx)
    expect(description).toEqual({ headline: HEADLINE, facts: [CHAT_FACT, SERVER_FACT, NAME_FACT, ...DEFAULTS] })
    expect(description).not.toHaveProperty("text")
    expect(description).not.toHaveProperty("pins")
  })

  test("shows a private thread and each archive time in words", async () => {
    const f = await createThreadsFixture()
    const facts = async (extra: Record<string, unknown>) =>
      (await callDescription(discordThreadCreate, { channel: CHANNEL, name: NAME, ...extra }, f.ctx))!.facts.slice(3)
    expect(await facts({ private: true })).toEqual([{ label: "Visibility", value: { text: "Private" } }, DEFAULTS[1]])
    for (const [minutes, words] of [
      [60, "1 hour"],
      [1440, "1 day"],
      [4320, "3 days"],
      [10080, "1 week"],
    ] as const) {
      expect((await facts({ auto_archive: minutes }))[1]).toEqual({ label: "Archives after", value: { text: words } })
    }
  })

  test("shows the author and the start of the message a thread starts from, before the name", async () => {
    const f = await createThreadsFixture()
    const description = await callDescription(
      discordThreadCreate,
      { channel: CHANNEL, message: SAID, name: NAME },
      f.ctx,
    )
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      { label: "Author", value: expect.any(String) },
      { label: "Message", value: `text ${SAID.slice(-3)}` },
      NAME_FACT,
      ...DEFAULTS,
    ])
  })

  test("names an announcement channel by its name", async () => {
    const f = await createThreadsFixture()
    const description = await callDescription(discordThreadCreate, { channel: ANNOUNCEMENT, name: NAME }, f.ctx)
    expect(description?.headline).toEqual({ text: HEADLINE.text, values: { chat: "#news" } })
    expect(description?.facts[0]).toEqual({ label: "Chat", value: { text: "Announcement channel" } })
  })

  test("gives the same answer twice and sends no request", async () => {
    const f = await createThreadsFixture()
    const args = { channel: CHANNEL, name: NAME }
    const first = await callDescription(discordThreadCreate, args, f.ctx)
    expect(await callDescription(discordThreadCreate, args, f.ctx)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })

  test.each([
    ["a channel the mirror lacks", { channel: "1400000000000000999" }],
    ["a message the mirror lacks", { message: msgId(999) }],
    ["a message of another channel", { message: NEWS_MESSAGE }],
  ])("gives no description for %s, and sends no request", async (_, extra) => {
    const f = await createThreadsFixture()
    const args = { channel: CHANNEL, name: NAME, ...extra }
    expect(await callDescription(discordThreadCreate, args, f.ctx)).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})
