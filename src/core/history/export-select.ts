import { knownChannelId, mirroredChannelId } from "../chats/channel-target"
import type { MessageBounds } from "../chats/bounds"
import { ITEM_COLUMNS, type ItemRow, itemOf } from "../chats/message-items"
import type { MessageItem } from "../chats/message-schemas"
import { messagePermalink } from "../chats/permalink"
import type { ChatSession } from "../chats/session"
import { getCursor, isChannelCurrent } from "../discord/mirror-cursors"
import { ToolError } from "../errors"
import { placesOf } from "../inbox/places"
import type { ChatCount } from "./schemas"

/** How many messages an export holds when `limit` is left out. */
export const EXPORT_LIMIT_DEFAULT = 2000

/** The most messages one export holds. */
export const EXPORT_LIMIT_MAX = 10000

/** One message of an export: the item the reads give, and the link to it. */
export type ExportMessage = MessageItem & { permalink: string }

/** How to go on from an export; each hint is `null` or `false` when there is nothing to continue. */
export type ExportContinue = {
  /** Export again with this `before` for the messages the mirror holds below the first one. */
  older: { before: string } | null
  /** The mirror reaches no further back, though the chat does: backfill it first, then export again. */
  backfill_first: boolean
  /** Export again with this `after` for the newer messages `limit` cut. */
  newer: { after: string } | null
}

/** What an export holds, from the mirror alone. */
export type ExportSelection = {
  chat: ChatCount["chat"]
  /** Oldest first; never empty. */
  messages: ExportMessage[]
  /** Whether the mirror reaches the chat's first message and nothing vouched lies below the first message. */
  complete_to_start: boolean
  /** Whether `limit` cut the selection. */
  truncated: boolean
  /** Whether a sync run marked the chat current in the last 15 minutes. */
  current: boolean
  /** How many stored messages lie past the newest the mirror vouches for (within `before`), and so are not in the file. */
  left_out: number
  continue: ExportContinue
}

/** What an export of one chat is asked for: the chat's id, the exclusive bounds (see `parseBounds`) and the most messages. */
export type ExportRange = MessageBounds & { chat: string; limit?: number }

/** The part of a chat the mirror holds in one piece: every id from `oldest` up to `newest`. */
type Held = { oldest: bigint; newest: bigint; complete: boolean }

/**
 * What the mirror holds of `chat` in one piece, whether or not a sync run
 * marked the chat current lately. `not_found` when the chat has no cursor, no
 * newest edge, or no oldest edge while its history is incomplete: nothing
 * there is vouched for.
 */
function vouchedOf(session: ChatSession, chat: string): Held {
  const cursor = getCursor(session.mirror, chat)
  if (!cursor || cursor.newest === null || (cursor.oldest === null && !cursor.complete)) {
    throw new ToolError(
      "not_found",
      `The mirror holds no history of chat ${chat} in one piece: sync it, or read it with \`discord_chat_read\` method \`messages\` or \`backfill\` first.`,
    )
  }
  return { oldest: BigInt(cursor.oldest ?? "0"), newest: BigInt(cursor.newest), complete: cursor.complete }
}

/**
 * Up to `limit + 1` rows of `chat` with ids from `lo` to `hi`: the newest ones
 * unless `fromStart`, else the first ones from `lo` upward. Oldest first.
 */
function rowsOf(
  session: ChatSession,
  chat: string,
  [lo, hi]: [bigint, bigint],
  limit: number,
  fromStart: boolean,
): ItemRow[] {
  const rows = session.mirror
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.author
       WHERE m.channel = ? AND m.id >= ? AND m.id <= ? ORDER BY m.id ${fromStart ? "ASC" : "DESC"} LIMIT ?`,
    )
    .all(BigInt(chat), lo, hi, limit + 1) as ItemRow[]
  return fromStart ? rows : rows.reverse()
}

/** Whether `chat` has a stored message with an id from `oldest` up to, but not including, `first`. */
function holdsBelow(session: ChatSession, chat: string, oldest: bigint, first: string): boolean {
  return (
    session.mirror
      .prepare("SELECT 1 FROM messages WHERE channel = ? AND id >= ? AND id < ? LIMIT 1")
      .get(BigInt(chat), oldest, BigInt(first)) !== undefined
  )
}

/** How many messages of `chat` are stored past `newest` (and below the exclusive bound `before`, when given). */
function leftOut(session: ChatSession, chat: string, newest: bigint, before?: string): number {
  const row = session.mirror
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND id > ?${before === undefined ? "" : " AND id < ?"}`,
    )
    .get(BigInt(chat), newest, ...(before === undefined ? [] : [BigInt(before)])) as { n: number }
  return row.n
}

/**
 * The messages an export of a chat holds, from the mirror alone; no request is
 * made. The chat need not be current: what is vouched is the range from the
 * cursor's oldest edge (the chat's start when its history is complete) to its
 * newest, and messages stored past that edge are left out and counted. Within
 * the bounds, without `after` the newest `limit` messages are taken, with it
 * the first `limit` from there upward; every type of message is included,
 * system messages too.
 *
 * `not_found` for a chat the mirror does not know or holds no history of in one
 * piece, `invalid_argument` for a category, a forum or a media channel and for
 * bounds that select no mirrored message, so no export is ever empty.
 */
export function selectExport(session: ChatSession, range: ExportRange): ExportSelection {
  const limit = range.limit ?? EXPORT_LIMIT_DEFAULT
  knownChannelId(session, range.chat)
  const server = mirroredChannelId(session, range.chat).server
  const vouched = vouchedOf(session, range.chat)

  const afterLow = range.after === undefined ? vouched.oldest : BigInt(range.after) + 1n
  const beforeHigh = range.before === undefined ? vouched.newest : BigInt(range.before) - 1n
  const from = afterLow > vouched.oldest ? afterLow : vouched.oldest
  const to = beforeHigh < vouched.newest ? beforeHigh : vouched.newest
  const fromStart = range.after !== undefined
  const rows = from > to ? [] : rowsOf(session, range.chat, [from, to], limit, fromStart)
  if (rows.length === 0) {
    throw new ToolError("invalid_argument", `The mirror holds no messages of chat ${range.chat} in that range.`)
  }
  const truncated = rows.length > limit
  if (truncated) {
    // The extra row is the one past `limit`: the newest when reading from `after`, else the oldest.
    if (fromStart) rows.pop()
    else rows.shift()
  }
  const first = rows[0]!.id
  const last = rows[rows.length - 1]!.id

  const older = holdsBelow(session, range.chat, vouched.oldest, first)
  const places = placesOf(session.mirror)
  return {
    chat: {
      id: range.chat,
      name: places.chat(range.chat),
      kind: places.kind(range.chat),
      server,
      server_name: places.server(server),
    },
    messages: rows.map((row) => ({
      ...itemOf(row, session.me),
      permalink: messagePermalink(server, range.chat, row.id),
    })),
    complete_to_start: vouched.complete && !older,
    truncated,
    current: isChannelCurrent(session.mirror, range.chat, session.now()),
    left_out: leftOut(session, range.chat, vouched.newest, range.before),
    continue: {
      older: older ? { before: first } : null,
      backfill_first: !older && !vouched.complete,
      newer: fromStart && truncated ? { after: last } : null,
    },
  }
}
