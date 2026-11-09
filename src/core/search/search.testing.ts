import { CURRENT_MS, markCurrent } from "../discord/mirror-cursors"
import { ingestChannels, ingestMessages, ingestServers } from "../discord/ingest"
import {
  channelObject,
  CHANNEL,
  DM,
  messageObject,
  msgId,
  OTHER_CHANNEL,
  SERVER,
  serverObject,
  userObject,
  ALICE,
} from "../discord/objects.testing"
import { CATEGORY, FORUM } from "../chats/read.messages.testing"
import { createChatFixture } from "../chats/read.testing"
import { invoke } from "../tool"
import { discordSearchRead } from "./read"

/** A second server, one of its channels, and a thread under `CHANNEL` and a post of `FORUM`; made-up ids. */
export const OTHER_SERVER = "1400000000000000101"
export const FAR_CHANNEL = "1400000000000000202"
export const THREAD = "1400000000000000401"
export const POST = "1400000000000000402"

/** A signed-in label with a mirror and a fake Discord behind the one HTTP client, and a way to run `discord_search_read`. */
export async function createSearchFixture() {
  const f = await createChatFixture()
  return {
    ...f,
    /** Runs `discord_search_read` as an entry point does: strict arguments, a result checked against its schema. */
    search: (args: unknown) => invoke(discordSearchRead, args, f.ctx),
  }
}

export type SearchFixture = Awaited<ReturnType<typeof createSearchFixture>>

/**
 * Stores two servers and these chats: the text channels `CHANNEL` and
 * `OTHER_CHANNEL` and the thread `THREAD` under `CHANNEL`, a forum with a post,
 * a category, a text channel of the other server, and a DM that has no name.
 */
export function seedWorld(f: SearchFixture): void {
  f.seed((m) => {
    const ctx = f.ingestContext()
    ingestServers(m, ctx, [serverObject(SERVER), serverObject(OTHER_SERVER)])
    ingestChannels(
      m,
      ctx,
      [
        channelObject(CHANNEL),
        channelObject(OTHER_CHANNEL, { name: "random" }),
        channelObject(FORUM, { type: 15, name: "ideas" }),
        channelObject(CATEGORY, { type: 4, name: "talk" }),
        channelObject(THREAD, { type: 11, name: "a thread", parent_id: CHANNEL }),
        channelObject(POST, { type: 11, name: "a post", parent_id: FORUM }),
      ],
      SERVER,
    )
    ingestChannels(m, ctx, [channelObject(FAR_CHANNEL, { name: "far" })], OTHER_SERVER)
    ingestChannels(m, ctx, [channelObject(DM, { type: 1, name: null, recipients: [userObject(ALICE)] })])
  })
}

/** The message `msgId(n)` in `channel`, as Discord sends it. */
export const said = (channel: string, n: number, extra: Record<string, unknown> = {}) =>
  messageObject(msgId(n), channel, extra)

/** Stores the messages as a channel's history would (their reactions are authoritative). */
export function store(f: SearchFixture, ...messages: ReturnType<typeof messageObject>[]): void {
  f.seed((m) => ingestMessages(m, f.ingestContext(), messages, { reactions: true }))
}

/** Marks the chats current `ago` milliseconds before the fixture's clock; an `ago` of `CURRENT_MS` or more leaves them stale. */
export function markSynced(f: SearchFixture, ago: number, ...channels: string[]): void {
  f.seed((m) => {
    for (const channel of channels) markCurrent(m, channel, f.now() - ago)
  })
}

/** An `ago` that leaves a chat stale. */
export const STALE_AGO = CURRENT_MS + 60_000

/** The numbers `n` of `msgId(n)` of a result's messages, in the result's order. */
export const numbersOf = (result: { messages: { id: string }[] }) =>
  result.messages.map((message) => Number(BigInt(message.id) - BigInt(msgId(0))))
