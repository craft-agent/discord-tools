import { UNTRUSTED_NOTE } from "../chats/format"
import { itemOf, reactionsNote } from "../chats/message-items"
import { ingestMessages } from "../discord/ingest"
import { rowsOfIds } from "../search/items"
import { MENTIONS_LIMIT_DEFAULT } from "./args"
import { mentionsPage } from "./mentions-page"
import { placesOf } from "./places"
import type { InboxHandler } from "./schemas"

/** Where Discord lists the messages that mention the account. */
const MENTIONS_PATH = "/users/@me/mentions"

/** What the result of `mentions` tells about its source, its reach, its paging and what was stored. */
const MENTIONS_NOTE =
  "Discord's own list of messages from the past 7 days that mention the user, the user's roles, @everyone or @here, newest first, servers the sync does not follow included. They were stored in the local mirror (reaction counts are not part of the list); nothing was marked read, so the phone's unread state is as it was. Pass `next_before` as `before` for older ones."

/**
 * Method `mentions`: Discord's own list of messages that mention the user,
 * their roles, `@everyone` or `@here`, newest first, stored in the mirror and
 * read back as the other reads do. The list is not contiguous history:
 * nothing is deleted, stored reactions are kept and no chat is marked current.
 * `next_before` is the oldest message of the page whenever it was full.
 */
export const readMentions: InboxHandler = async (session, args) => {
  const limit = args.limit ?? MENTIONS_LIMIT_DEFAULT
  const value = await session.client().read("GET", MENTIONS_PATH, {
    query: { limit, roles: true, everyone: true, guild_id: args.server, before: args.before },
    ...(session.signal ? { signal: session.signal } : {}),
  })
  const page = mentionsPage(value, args.before, limit)
  session.store((ctx) => {
    // Discord filtered by the server, so a message it sent without one is in that server.
    const found = page.messages.map((message) =>
      args.server === undefined || message.guild_id != null ? message : { ...message, guild_id: args.server },
    )
    ingestMessages(session.mirror, ctx, found, { reactions: false })
  })
  const ids = page.messages.map((message) => message.id as string)
  const places = placesOf(session.mirror)
  const messages = rowsOfIds(session, ids).map((row) => ({
    ...itemOf(row, session.me),
    channel: row.channel,
    chat: places.chat(row.channel),
    server: row.server,
    server_name: places.server(row.server),
  }))
  const oldest = ids.at(-1)
  return {
    source: "discord",
    note: `${MENTIONS_NOTE} ${UNTRUSTED_NOTE}`,
    messages,
    ...(page.full && oldest !== undefined ? { next_before: oldest } : {}),
    ...reactionsNote(messages),
  }
}
