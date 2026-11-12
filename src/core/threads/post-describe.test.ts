import { describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { CHANNEL, SERVER } from "../discord/objects.testing"
import { BUG, createPostsFixture, IDEA, POST, STRANGER, STRICT_BARE_FORUM, STRICT_FORUM, TEXT } from "./post.testing"
import { discordPostCreate } from "./post-tool"
import { FORUM, MEDIA, NAME } from "./threads.testing"

const HEADLINE = { text: "About to post in {chat}", values: { chat: "#ideas" } }
const CHAT_FACT = { label: "Chat", value: { text: "Channel" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const NAME_FACT = { label: "Name", value: NAME }
const LENGTH_FACT = { label: "Length", value: { text: "{count} characters", values: { count: TEXT.length } } }

/** The description of a valid post call with `extra` over it. */
async function describePost(extra: Record<string, unknown> = {}) {
  const f = await createPostsFixture()
  const description = await callDescription(discordPostCreate, { ...POST, ...extra }, f.ctx)
  return { f, description }
}

describe("discord_post_create description", () => {
  test("describes a post with the forum, the name as given, the length and the text verbatim", async () => {
    const { description } = await describePost()
    expect(description).toEqual({
      headline: HEADLINE,
      facts: [CHAT_FACT, SERVER_FACT, NAME_FACT, LENGTH_FACT],
      text: { label: "Message text", body: TEXT },
    })
    expect(description).not.toHaveProperty("pins")
  })

  test("names the tags by the names the mirror holds, in the order given", async () => {
    const { description } = await describePost({ tags: [IDEA, BUG] })
    expect(description?.facts).toEqual([
      CHAT_FACT,
      SERVER_FACT,
      NAME_FACT,
      { label: "Tags", value: "Idea, Bug" },
      LENGTH_FACT,
    ])
  })

  test("shows mass mentions and silent between the tags and the length", async () => {
    const { description } = await describePost({ tags: [BUG], mass_mentions: true, silent: true })
    expect(description?.facts.slice(3)).toEqual([
      { label: "Tags", value: "Bug" },
      { label: "Mass mentions", value: { text: "Notify" } },
      { label: "Notifications", value: { text: "Silent" } },
      LENGTH_FACT,
    ])
  })

  test("leaves out mass mentions and notifications when they are false", async () => {
    const { description } = await describePost({ mass_mentions: false, silent: false })
    expect(description?.facts).toEqual([CHAT_FACT, SERVER_FACT, NAME_FACT, LENGTH_FACT])
  })

  test("counts the length in code points", async () => {
    const { description } = await describePost({ text: "a😀" })
    expect(description?.facts.at(-1)).toEqual({
      label: "Length",
      value: { text: "{count} characters", values: { count: 2 } },
    })
    expect((await describePost({ text: "a" })).description?.facts.at(-1)).toEqual({
      label: "Length",
      value: { text: "{count} character", values: { count: 1 } },
    })
  })

  test("keeps the text as written, including mentions and surrounding space", async () => {
    const text = "  @everyone <@&123>\n\nkept  "
    expect((await describePost({ text })).description?.text).toEqual({ label: "Message text", body: text })
  })

  test("keeps a name of 100 characters out of the headline, which has the forum alone", async () => {
    const name = "é".repeat(100)
    const { description } = await describePost({ name })
    expect(description?.headline).toEqual(HEADLINE)
    expect(description?.facts).toContainEqual({ label: "Name", value: name })
  })

  test("describes a media channel and a forum that requires a tag given one", async () => {
    const f = await createPostsFixture()
    expect((await callDescription(discordPostCreate, { ...POST, channel: MEDIA }, f.ctx))?.headline).toEqual({
      text: HEADLINE.text,
      values: { chat: "#gallery" },
    })
    const strict = await callDescription(discordPostCreate, { ...POST, channel: STRICT_FORUM, tags: [BUG] }, f.ctx)
    expect(strict?.headline).toEqual({ text: HEADLINE.text, values: { chat: "#rules" } })
  })

  test("gives the same answer twice and sends no request", async () => {
    const { f, description } = await describePost({ tags: [BUG] })
    expect(await callDescription(discordPostCreate, { ...POST, tags: [BUG] }, f.ctx)).toEqual(description)
    expect(f.discord.api).toEqual([])
  })

  test.each([
    ["a channel the mirror lacks", { channel: "1400000000000000999" }],
    ["a text channel", { channel: CHANNEL }],
    ["a tag the forum does not list", { tags: [STRANGER] }],
    ["tags in a forum whose tags the mirror does not hold", { channel: FORUM, tags: [BUG] }],
    ["no tag in a forum that requires one", { channel: STRICT_FORUM }],
    ["no tag in a forum that requires one and whose tags are unknown", { channel: STRICT_BARE_FORUM }],
    ["a tag given twice", { tags: [BUG, BUG] }],
    ["a channel that is a name", { channel: "ideas" }],
  ])("gives no description for %s, and sends no request", async (_, extra) => {
    const { f, description } = await describePost(extra)
    expect(description).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})
