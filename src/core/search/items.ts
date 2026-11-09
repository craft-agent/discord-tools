import { isoOrNull } from "../chats/format"
import { ITEM_COLUMNS, type ItemRow, itemOf } from "../chats/message-items"
import type { ChatSession } from "../chats/session"
import { getCursor, isChannelCurrent } from "../discord/mirror-cursors"
import type { SearchChatItem, SearchMessageItem } from "./schemas"

/** A stored message with the chat it is in. */
export type SearchRow = ItemRow & { channel: string; server: string | null; channel_name: string | null }

/** The start of every query for `SearchRow`s: add a `WHERE` and what follows. */
export const SEARCH_ROWS_SELECT = `SELECT ${ITEM_COLUMNS}, CAST(m.channel AS TEXT) AS channel, CAST(COALESCE(m.server, c.server) AS TEXT) AS server,
              c.name AS channel_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.author
       LEFT JOIN channels c ON c.id = m.channel`

/** The stored messages with these ids, in the order of `ids`; an id the mirror does not hold is left out. */
export function rowsOfIds(session: ChatSession, ids: readonly string[]): SearchRow[] {
  if (ids.length === 0) return []
  const rows = session.mirror
    .prepare(`${SEARCH_ROWS_SELECT} WHERE m.id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids.map((id) => BigInt(id))) as SearchRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/** One entry for each chat the rows are in, in the order they first appear, with when a sync run last marked it current. */
function chatsOf(session: ChatSession, rows: readonly SearchRow[]): SearchChatItem[] {
  const chats = new Map<string, SearchChatItem>()
  for (const row of rows) {
    if (chats.has(row.channel)) continue
    chats.set(row.channel, {
      id: row.channel,
      name: row.channel_name,
      server: row.server,
      synced_at: isoOrNull(getCursor(session.mirror, row.channel)?.syncedAt ?? null),
      current: isChannelCurrent(session.mirror, row.channel, session.now()),
    })
  }
  return [...chats.values()]
}

/** The items and chats of these rows, in their order; every method builds a message item here, so it is the same whichever found it. */
export function itemsOf(
  session: ChatSession,
  rows: readonly SearchRow[],
): { messages: SearchMessageItem[]; chats: SearchChatItem[] } {
  return {
    messages: rows.map((row) => ({ ...itemOf(row, session.me), channel: row.channel, server: row.server })),
    chats: chatsOf(session, rows),
  }
}
