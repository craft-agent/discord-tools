import { knownChannelId } from "../chats/channel-target"
import type { ChannelTarget } from "../chats/message-page"
import type { ChatSession } from "../chats/session"
import { ToolError } from "../errors"

/** What the mirror holds of the message an action is about; `reactions` is the stored JSON column as it is. */
export type ActionMessage = {
  id: string
  fromMe: boolean
  type: number
  content: string | null
  reactions: string | null
  pinned: boolean
}

/** The chat and the message of an action, both as the mirror knows them. */
export type ActionTarget = { channel: ChannelTarget; message: ActionMessage }

type MessageRow = {
  id: string
  from_me: number
  type: number
  content: string | null
  reactions: string | null
  pinned: number
}

/**
 * The chat and the message an action names, as the mirror holds them. The
 * channel is refused as `knownChannel` does; `not_found` when the mirror holds
 * no such message in it.
 */
export function actionTarget(session: ChatSession, channel: string, message: string): ActionTarget {
  const target = knownChannelId(session, channel)
  const row = session.mirror
    .prepare(
      "SELECT CAST(id AS TEXT) AS id, from_me, type, content, reactions, pinned FROM messages WHERE id = ? AND channel = ?",
    )
    .get(BigInt(message), BigInt(channel)) as MessageRow | undefined
  if (!row) {
    throw new ToolError(
      "not_found",
      `The mirror holds no message ${message} in channel ${channel}: read the chat with discord_chat_read first, then name a message it lists.`,
    )
  }
  return {
    channel: target,
    message: {
      id: row.id,
      fromMe: row.from_me === 1,
      type: row.type,
      content: row.content,
      reactions: row.reactions,
      pinned: row.pinned === 1,
    },
  }
}

/** Refuses a message that is not the account's own as `forbidden`, before anything is sent. */
export function ownMessage({ channel, message }: ActionTarget): void {
  if (!message.fromMe) {
    throw new ToolError(
      "forbidden",
      `Only the account's own messages can be edited or deleted: message ${message.id} in channel ${channel.id} was written by someone else.`,
    )
  }
}
