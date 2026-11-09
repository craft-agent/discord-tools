import { newCounts, type IngestCounts } from "./ingest-context"
import { idOrNull } from "./ingest-values"
import type { Mirror } from "./mirror"

/**
 * Follows a pin or an unpin on a stored message after Discord took it. Counts
 * the change as stored; a message already in that state, in which case nothing
 * is written, is not counted, and a message the mirror does not hold or an
 * invalid id is skipped.
 */
export function setPinned(mirror: Mirror, id: string, pinned: boolean): IngestCounts {
  const counts = newCounts()
  const messageId = idOrNull(id)
  const row =
    messageId === null
      ? undefined
      : (mirror.prepare("SELECT pinned FROM messages WHERE id = ?").get(messageId) as { pinned: number } | undefined)
  if (messageId === null || row === undefined) {
    counts.skipped += 1
    return counts
  }
  const next = pinned ? 1 : 0
  if (row.pinned !== next) {
    mirror.prepare("UPDATE messages SET pinned = ? WHERE id = ?").run(next, messageId)
    counts.stored += 1
  }
  return counts
}
