import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { SERVER } from "../discord/objects.testing"
import { createMembershipFixture, FORUM_POST, type MembershipFixture, PRIVATE_THREAD } from "./membership.testing"
import { discordThreadJoin, discordThreadLeave } from "./membership-tool"
import { OLD_THREAD } from "./threads.testing"

let f: MembershipFixture

beforeEach(async () => {
  f = await createMembershipFixture()
})

afterEach(() => f.dispose())

const CHAT_FACT = { label: "Chat", value: { text: "Thread" } }
const SERVER_FACT = { label: "Server", value: SERVER }
const CHANNEL_FACT = { label: "Channel", value: "#general" }

describe.each([
  ["discord_thread_join", discordThreadJoin, "About to join {chat}"],
  ["discord_thread_leave", discordThreadLeave, "About to leave {chat}"],
] as const)("%s description", (_, tool, text) => {
  test("names the thread as people see it, with the chat's facts and no text", async () => {
    const description = await callDescription(tool, { thread: OLD_THREAD }, f.ctx)
    expect(description).toEqual({
      headline: { text, values: { chat: "old" } },
      facts: [CHAT_FACT, SERVER_FACT, CHANNEL_FACT],
    })
    expect(description).not.toHaveProperty("text")
    expect(description).not.toHaveProperty("pins")
  })

  test("calls a private thread one, and names a forum post by its own name", async () => {
    const secret = await callDescription(tool, { thread: PRIVATE_THREAD }, f.ctx)
    expect(secret?.facts).toEqual([{ label: "Chat", value: { text: "Private thread" } }, SERVER_FACT, CHANNEL_FACT])
    const post = await callDescription(tool, { thread: FORUM_POST }, f.ctx)
    expect(post?.headline).toEqual({ text, values: { chat: "a post" } })
  })

  test("gives the same answer twice and sends no request", async () => {
    const first = await callDescription(tool, { thread: OLD_THREAD }, f.ctx)
    expect(await callDescription(tool, { thread: OLD_THREAD }, f.ctx)).toEqual(first)
    expect(f.discord.api).toEqual([])
  })

  test("gives no description for a channel the mirror lacks, and sends no request", async () => {
    expect(await callDescription(tool, { thread: "1400000000000000999" }, f.ctx)).toBeUndefined()
    expect(f.discord.api).toEqual([])
  })
})
