import { MESSAGES_LIMIT_DEFAULT } from "./args"
import { parseBounds } from "./bounds"
import { knownChannel } from "./channel-target"
import { messageItems, reactionsNote } from "./message-items"
import type { MessagePage, MessageRequest } from "./message-page"
import { messagesFromDiscord } from "./messages-live"
import { messagesFromMirror } from "./messages-mirror"
import type { ChatHandler } from "./session"

/**
 * Method `messages`: the newest messages of a chat before `before` (and after
 * `after`), or with only `after` the oldest ones after it; oldest first.
 * From the mirror while the chat is current and the request lies within what
 * the mirror vouches for, else from Discord, storing the page.
 */
export const readMessages: ChatHandler = async (session, args) => {
  const channel = knownChannel(session, args)
  const bounds = parseBounds(args.before, args.after)
  const request: MessageRequest = {
    ...bounds,
    channel,
    limit: args.limit ?? MESSAGES_LIMIT_DEFAULT,
    direction: bounds.before === undefined && bounds.after !== undefined ? "forward" : "backward",
  }
  const fromMirror = args.live === true ? null : messagesFromMirror(session, request)
  const page: MessagePage = fromMirror ?? (await messagesFromDiscord(session, request))
  const messages = messageItems(session, channel.id, page.ids)
  return {
    source: fromMirror ? "mirror" : "live",
    channel: channel.id,
    messages,
    next_before: page.next_before,
    next_after: page.next_after,
    ...reactionsNote(messages),
  }
}
