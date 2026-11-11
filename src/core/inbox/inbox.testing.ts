import { ingestChannels } from "../discord/ingest"
import { BOB, channelObject, ALICE, messageObject, ME, msgId, userObject } from "../discord/objects.testing"
import { createSearchFixture, numbersOf, said } from "../search/search.testing"
import { invoke } from "../tool"
import { discordInboxRead } from "./read"

/** The path of Discord's list of mentions. */
export const MENTIONS_PATH = "/users/@me/mentions"

/** A group DM of the user, Alice and Bob; a made-up id. */
export const GROUP = "1400000000000000301"

/** A signed-in label with a mirror and a fake Discord behind the one HTTP client, and a way to run `discord_inbox_read`. */
export async function createInboxFixture() {
  const f = await createSearchFixture()
  return {
    ...f,
    /** Runs `discord_inbox_read` as an entry point does: strict arguments, a result checked against its schema. */
    inbox: (args: unknown) => invoke(discordInboxRead, args, f.ctx),
  }
}

export type InboxFixture = Awaited<ReturnType<typeof createInboxFixture>>

/** Stores the group DM `GROUP`, named `Team`, as a DM list would. */
export function seedGroup(f: InboxFixture): void {
  f.seed((m) =>
    ingestChannels(m, f.ingestContext(), [
      channelObject(GROUP, { type: 3, name: "Team", recipients: [userObject(ALICE), userObject(BOB)] }),
    ]),
  )
}

/** The message `msgId(n)` in `channel`, written by the user. */
export const mine = (channel: string, n: number, extra: Record<string, unknown> = {}) =>
  messageObject(msgId(n), channel, { author: userObject(ME), ...extra })

/** The message `msgId(n)` in `channel`, a reply to the message `msgId(to)`. */
export const replying = (channel: string, n: number, to: number, extra: Record<string, unknown> = {}) =>
  said(channel, n, { type: 19, message_reference: { message_id: msgId(to), channel_id: channel }, ...extra })

/** The message `msgId(n)` in `channel`, mentioning the user. */
export const mentioning = (channel: string, n: number, extra: Record<string, unknown> = {}) =>
  said(channel, n, { mentions: [userObject(ME)], ...extra })

/** The numbers `n` of `msgId(n)` of a `mentions` result's messages, in the result's order. */
export const numbersOfMentions = (result: { messages?: { id: string }[] }) =>
  numbersOf({ messages: result.messages ?? [] })

/** The chats of a `waiting` result, as their ids. */
export const chatIds = (result: { chats?: { chat: { id: string } }[] }) => result.chats?.map(({ chat }) => chat.id)
