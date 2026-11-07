import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import { storeMessages } from "./ingest-messages"
import { idOrNull, isRecord } from "./ingest-values"
import type { Mirror } from "./mirror"
import { setCursorEdges } from "./mirror-cursors"
import { deleteMessageRow, messageIdsBetween } from "./mirror-rows"
import type { HistoryPage } from "./sync-page"

/** The lower bound of a range: a snowflake, or `"0"` for the start of a channel. */
function lowerBound(value: string): bigint | null {
  return value === "0" ? 0n : idOrNull(value)
}

/**
 * Stores a contiguous page of one channel's history, then deletes the
 * channel's mirrored messages strictly between `range.after` and
 * `range.before` that the page did not return: those were deleted on Discord.
 * Reactions are replaced, as a page is authoritative for them.
 *
 * The caller computes `range` (`after` may be `"0"`); this only trusts it. A
 * message of another channel is skipped, and no other channel is touched. An
 * invalid range deletes nothing.
 */
export function ingestHistoryPage(
  mirror: Mirror,
  ctx: IngestContext,
  channel: string,
  messages: unknown[],
  range: { after: string; before: string },
): IngestCounts {
  const own = messages.filter((message) => isRecord(message) && message.channel_id === channel)
  const { counts, ids } = storeMessages(mirror, ctx, own, true)
  counts.skipped += messages.length - own.length
  const channelId = idOrNull(channel)
  const after = lowerBound(range.after)
  const before = idOrNull(range.before)
  if (channelId === null || after === null || before === null) return counts
  for (const id of messageIdsBetween(mirror, channelId, after, before)) {
    if (!ids.has(id)) counts.deleted += deleteMessageRow(mirror, id)
  }
  return counts
}

/**
 * The one way a tool extends a chat's vouched history downward: stores an older
 * page as `ingestHistoryPage` does, then widens the cursor's `oldest` edge to
 * the page's oldest message, and sets `complete` when the page reached the
 * channel's first message. The caller requested the page with `before` = the
 * cursor's current oldest edge, so the page joins the vouched range.
 *
 * It never touches `newest`, `synced_at` or `rechecked_at`: only a sync run
 * marks a channel current.
 */
export function ingestOlderHistory(
  mirror: Mirror,
  ctx: IngestContext,
  channel: string,
  page: HistoryPage,
): IngestCounts {
  const counts = ingestHistoryPage(mirror, ctx, channel, page.messages, page.range)
  setCursorEdges(mirror, channel, {
    ...(page.oldest === undefined ? {} : { oldest: page.oldest }),
    complete: page.complete,
  })
  return counts
}

/** Removes one message known to be deleted; an invalid id is skipped. */
export function deleteMessage(mirror: Mirror, id: string): IngestCounts {
  const counts = newCounts()
  const messageId = idOrNull(id)
  if (messageId === null) counts.skipped += 1
  else counts.deleted += deleteMessageRow(mirror, messageId)
  return counts
}
