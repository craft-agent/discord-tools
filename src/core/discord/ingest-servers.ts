import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import { idOrNull, isRecord, textOrNull } from "./ingest-values"
import type { Mirror } from "./mirror"
import { upsertServer } from "./mirror-rows"

/**
 * Stores the entries of the user's server list (`id`, `name`, `owner`, `icon`).
 * An entry without `owner` keeps the stored one.
 */
export function ingestServers(mirror: Mirror, ctx: IngestContext, servers: unknown[]): IngestCounts {
  const counts = newCounts()
  for (const entry of servers) {
    const id = isRecord(entry) ? idOrNull(entry.id) : null
    if (!isRecord(entry) || id === null) {
      counts.skipped += 1
      continue
    }
    upsertServer(mirror, {
      id,
      name: textOrNull(entry.name),
      owner: typeof entry.owner === "boolean" ? (entry.owner ? 1 : 0) : null,
      icon: textOrNull(entry.icon),
      raw: JSON.stringify(entry),
      updated: ctx.now,
    })
    counts.stored += 1
  }
  return counts
}
