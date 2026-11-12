import { mirroredChannelId, type MirroredChannel } from "../chats/channel-target"
import { THREAD_TYPES } from "../chats/channels"
import { mirroredMessage } from "../chats/describe"
import { DM_TYPE, GROUP_DM_TYPE } from "../chats/dms"
import { channelKind } from "../chats/format"
import type { ChatSession } from "../chats/session"
import { ToolError } from "../errors"
import type { ThreadCreateInput } from "./schemas"

/** The channel type of a text channel, the only one a private thread can start in. */
const TEXT_TYPE = 0

/** The channel type of an announcement channel. */
const ANNOUNCEMENT_TYPE = 5

/** The channel types a thread can start in: text and announcement. */
const THREAD_PARENT_TYPES: readonly number[] = [TEXT_TYPE, ANNOUNCEMENT_TYPE]

/** What a channel that cannot hold a thread is, for the refusal. */
function refusedKind(type: number): string {
  const kind = channelKind(type)
  if (kind === "forum" || kind === "media") {
    return "a forum or media channel, which takes a post (discord_post_create), not a thread"
  }
  if (THREAD_TYPES.includes(type))
    return "a thread, which cannot hold another: start it in the channel the thread belongs to"
  if (type === DM_TYPE || type === GROUP_DM_TYPE) return "a DM or group DM, which has no threads"
  return "not a text or announcement channel"
}

/** Refuses what the arguments contradict among themselves, before anything is opened: a private thread from a message. */
export function checkThreadArgs(args: Pick<ThreadCreateInput, "message" | "private">): void {
  if (args.private === true && args.message !== undefined) {
    throw new ToolError(
      "invalid_argument",
      "A thread started from a message is public: leave out `private`, or leave out `message` to start a private thread.",
    )
  }
}

/**
 * The channel a thread starts in, as the mirror knows it. `not_found` when the
 * mirror has no such channel or, for `message`, holds no such message in it;
 * `invalid_argument` for a channel that is not a text or announcement channel,
 * and for a private thread outside a text channel.
 */
export function threadParent(
  session: ChatSession,
  { channel, message, private: isPrivate }: Pick<ThreadCreateInput, "channel" | "message" | "private">,
): MirroredChannel {
  const parent = mirroredChannelId(session, channel)
  if (!THREAD_PARENT_TYPES.includes(parent.type)) {
    throw new ToolError(
      "invalid_argument",
      `Channel ${channel} is ${refusedKind(parent.type)}. A thread starts in a text or announcement channel of a server the mirror knows: find one with discord_chat_read, method channels.`,
    )
  }
  if (isPrivate === true && parent.type !== TEXT_TYPE) {
    throw new ToolError(
      "invalid_argument",
      `A private thread starts only in a text channel; channel ${channel} is an announcement channel.`,
    )
  }
  if (message !== undefined && !mirroredMessage(session.mirror, channel, message)) {
    throw new ToolError(
      "not_found",
      `The mirror holds no message ${message} in channel ${channel}: read the channel with discord_chat_read first, then start the thread from a message it lists.`,
    )
  }
  return parent
}
