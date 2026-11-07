import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import { flag, idOrNull, isRecord, textOrNull } from "./ingest-values"
import type { Mirror } from "./mirror"
import { upsertUser } from "./mirror-rows"

/**
 * Stores a user object (a user list entry, a message's author, a mention or a
 * DM recipient). Returns whether it was stored; an entry without a valid id is not.
 */
export function storeUser(mirror: Mirror, ctx: IngestContext, entry: unknown): boolean {
  const id = isRecord(entry) ? idOrNull(entry.id) : null
  if (!isRecord(entry) || id === null) return false
  upsertUser(mirror, {
    id,
    username: textOrNull(entry.username),
    global_name: textOrNull(entry.global_name),
    bot: flag(entry.bot),
    raw: JSON.stringify(entry),
    updated: ctx.now,
  })
  return true
}

/** Stores user objects: `username`, `global_name`, `bot` and the object as sent. */
export function ingestUsers(mirror: Mirror, ctx: IngestContext, users: unknown[]): IngestCounts {
  const counts = newCounts()
  for (const user of users) {
    if (storeUser(mirror, ctx, user)) counts.stored += 1
    else counts.skipped += 1
  }
  return counts
}
