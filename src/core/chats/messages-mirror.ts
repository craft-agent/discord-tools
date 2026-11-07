import type { MessagePage, MessageRequest } from "./message-page"
import type { ChatSession } from "./session"
import { vouchedRange } from "./vouched"

type IdRow = { id: string }

/** Ids of a channel's messages in a range, in `order`, one more than `limit` so the caller can tell whether more follow. */
function idsIn(
  session: ChatSession,
  request: MessageRequest,
  range: { above: bigint; below?: bigint },
  order: "ASC" | "DESC",
): string[] {
  const upper = range.below === undefined ? "" : "AND id < ?"
  const rows = session.mirror
    .prepare(
      `SELECT CAST(id AS TEXT) AS id FROM messages WHERE channel = ? AND id > ? ${upper} ORDER BY id ${order} LIMIT ?`,
    )
    .all(
      BigInt(request.channel.id),
      range.above,
      ...(range.below === undefined ? [] : [range.below]),
      request.limit + 1,
    )
  return (rows as IdRow[]).map((row) => row.id)
}

/**
 * Answers a `messages` read from the mirror, or returns `null` when it cannot:
 * the channel is not current, or the request reaches below the part of the
 * history the mirror vouches for. The vouched part is every id from the
 * channel's oldest mirrored message up to now, so only a request that reaches
 * further back needs Discord.
 */
export function messagesFromMirror(session: ChatSession, request: MessageRequest): MessagePage | null {
  const vouched = vouchedRange(session, request.channel.id)
  if (!vouched) return null
  const floor = vouched.oldest - 1n
  const after = request.after === undefined ? undefined : BigInt(request.after)
  const reachesFloor = vouched.complete || (after !== undefined && after >= floor)

  if (request.direction === "forward") {
    if (!reachesFloor || after === undefined) return null
    const rows = idsIn(session, request, { above: after }, "ASC")
    const ids = rows.slice(0, request.limit)
    return { ids, next_before: null, next_after: rows.length > request.limit ? (ids.at(-1) ?? null) : null }
  }

  const above = after !== undefined && after > floor ? after : floor
  const below = request.before === undefined ? undefined : BigInt(request.before)
  const rows = idsIn(session, request, below === undefined ? { above } : { above, below }, "DESC")
  const ids = rows.slice(0, request.limit).reverse()
  if (ids.length < request.limit && !reachesFloor) return null
  const more = rows.length > request.limit || (ids.length === request.limit && !reachesFloor)
  return { ids, next_before: more ? (ids[0] ?? null) : null, next_after: null }
}
