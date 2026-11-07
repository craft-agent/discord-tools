import { z } from "zod"
import { displayName, idTime, isoOrNull } from "./format"
import { type MessageItem, messageItem } from "./message-schemas"
import type { ChatSession } from "./session"

/** Said in a result whose messages carry reactions: the counts are those stored when the message was last read. */
export const REACTIONS_NOTE = "Reaction counts are as of the last time the message was read."

/** The message types of a written message and of a reply; every other type is a system message. */
const WRITTEN_TYPES: readonly number[] = [0, 19]

/** What the system message types that have a short name record. */
const SYSTEM_EVENTS: Readonly<Record<number, string>> = {
  6: "pinned a message",
  7: "joined",
  8: "boosted",
  18: "started a thread",
  46: "poll result",
}

/** The event of a system message type without a name of its own. */
const OTHER_SYSTEM_EVENT = "system"

type ItemRow = {
  id: string
  type: number
  from_me: number
  author: string | null
  author_nick: string | null
  username: string | null
  global_name: string | null
  content: string
  ref_kind: "reply" | "forward" | null
  ref_message: string | null
  ref_channel: string | null
  mentions: string | null
  mention_everyone: number
  attachments: string | null
  embeds: string | null
  stickers: string | null
  reactions: string | null
  pinned: number
  created_at: number
  edited_at: number | null
}

const ITEM_COLUMNS = `CAST(m.id AS TEXT) AS id, m.type, m.from_me, CAST(m.author AS TEXT) AS author, m.author_nick,
  u.username, u.global_name, m.content, m.ref_kind, CAST(m.ref_message AS TEXT) AS ref_message,
  CAST(m.ref_channel AS TEXT) AS ref_channel, m.mentions, m.mention_everyone, m.attachments, m.embeds,
  m.stickers, m.reactions, m.pinned, m.created_at, m.edited_at`

/** The list a JSON column holds, or an empty one when the column is empty, is not JSON or is not shaped as `schema` says. */
function storedList<T>(schema: z.ZodType<T[]>, json: string | null): T[] {
  if (json === null) return []
  try {
    const parsed = schema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

function itemOf(row: ItemRow, me: string): MessageItem {
  const reference = { message: row.ref_message, channel: row.ref_channel }
  const mentions = storedList(z.array(z.string()), row.mentions)
  return {
    id: row.id,
    at: isoOrNull(row.created_at) ?? idTime(row.id),
    edited_at: isoOrNull(row.edited_at),
    type: row.type,
    event: WRITTEN_TYPES.includes(row.type) ? null : (SYSTEM_EVENTS[row.type] ?? OTHER_SYSTEM_EVENT),
    from_me: row.from_me === 1,
    author_id: row.author,
    author: row.author_nick ?? displayName(row),
    text: row.content,
    reply_to: row.ref_kind === "reply" ? reference : null,
    forwarded_from: row.ref_kind === "forward" ? reference : null,
    attachments: storedList(messageItem.shape.attachments, row.attachments),
    embeds: storedList(messageItem.shape.embeds, row.embeds),
    stickers: storedList(messageItem.shape.stickers, row.stickers),
    reactions: storedList(messageItem.shape.reactions, row.reactions),
    pinned: row.pinned === 1,
    mentions_me: row.mention_everyone === 1 || mentions.includes(me),
  }
}

/**
 * The messages of `channel` with these ids, read back from the mirror and
 * formatted, oldest first. Every result of `messages` and `around` goes through
 * here, whether the ids came from the mirror or from a page just stored, so
 * both sources give the same shape. An id the mirror does not hold is left out.
 */
export function messageItems(session: ChatSession, channel: string, ids: readonly string[]): MessageItem[] {
  if (ids.length === 0) return []
  const rows = session.mirror
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.author
       WHERE m.channel = ? AND m.id IN (${ids.map(() => "?").join(", ")}) ORDER BY m.id`,
    )
    .all(BigInt(channel), ...ids.map((id) => BigInt(id))) as ItemRow[]
  return rows.map((row) => itemOf(row, session.me))
}

/** `{ reactions_note }` when any of the messages has reactions, else nothing. */
export function reactionsNote(items: readonly MessageItem[]): { reactions_note?: string } {
  return items.some((item) => item.reactions.length > 0) ? { reactions_note: REACTIONS_NOTE } : {}
}
