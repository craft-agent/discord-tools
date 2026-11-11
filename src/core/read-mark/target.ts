import { actionTarget } from "../actions/target"
import { knownChannelId } from "../chats/channel-target"
import type { ChannelTarget } from "../chats/message-page"
import type { ChatSession } from "../chats/session"
import type { Mirror } from "../discord/mirror"
import { ToolError } from "../errors"

/** The chat a mark reaches and the id of the message it is up to. */
export type ReadMarkTarget = { channel: ChannelTarget; message: string }

/**
 * The newest message the mirror holds for a chat, by id; `invalid_argument`
 * when it holds none, since there is nothing to mark the chat read up to.
 */
export function newestMessageId(mirror: Mirror, channel: string): string {
  const row = mirror
    .prepare("SELECT CAST(MAX(id) AS TEXT) AS newest FROM messages WHERE channel = ?")
    .get(BigInt(channel)) as { newest: string | null }
  if (row.newest === null) {
    throw new ToolError(
      "invalid_argument",
      `The mirror holds no message of channel ${channel} to mark it read up to: read the chat with discord_chat_read first.`,
    )
  }
  return row.newest
}

/**
 * The chat and the message a mark names, as the mirror holds them. The channel
 * is refused as `knownChannelId` does; a given message must be one the mirror
 * holds in it (`not_found` otherwise), and without one the newest is taken.
 */
export function readMarkTarget(session: ChatSession, channel: string, message?: string): ReadMarkTarget {
  if (message !== undefined) {
    const target = actionTarget(session, channel, message)
    return { channel: target.channel, message: target.message.id }
  }
  return { channel: knownChannelId(session, channel), message: newestMessageId(session.mirror, channel) }
}
