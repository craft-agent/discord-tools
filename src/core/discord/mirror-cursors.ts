import type { Mirror } from "./mirror"
import { idOrNull } from "./ingest-values"

/** How far a channel's history is mirrored. Ids are text; `null` when unknown. */
export type Cursor = {
  /** The newest message id the mirror holds. */
  newest: string | null
  /** The oldest message id the mirror holds. */
  oldest: string | null
  /** Whether the mirrored history reaches the channel's first message. */
  complete: boolean
  /** When a sync run last marked the channel current (ms). */
  syncedAt: number | null
  /** When the channel's stored range was last checked against Discord (ms). */
  recheckedAt: number | null
}

type CursorRow = {
  newest: string | null
  oldest: string | null
  complete: number
  synced_at: number | null
  rechecked_at: number | null
}

/** A channel's cursor, or `undefined` when it has none. */
export function getCursor(mirror: Mirror, channel: string): Cursor | undefined {
  const id = idOrNull(channel)
  if (id === null) return undefined
  const row = mirror
    .prepare(
      `SELECT CAST(newest AS TEXT) AS newest, CAST(oldest AS TEXT) AS oldest, complete, synced_at, rechecked_at
       FROM cursors WHERE channel = ?`,
    )
    .get(id) as CursorRow | undefined
  if (!row) return undefined
  return {
    newest: row.newest,
    oldest: row.oldest,
    complete: row.complete === 1,
    syncedAt: row.synced_at,
    recheckedAt: row.rechecked_at,
  }
}

/**
 * Widens the known range of a channel's mirrored history: `newest` only
 * grows, `oldest` only shrinks and `complete` only goes from false to true.
 * A missing or invalid edge changes nothing; a channel without a cursor gets one.
 */
export function setCursorEdges(
  mirror: Mirror,
  channel: string,
  edges: { newest?: string; oldest?: string; complete?: boolean },
): void {
  const id = idOrNull(channel)
  if (id === null) return
  mirror
    .prepare(
      `INSERT INTO cursors (channel, newest, oldest, complete) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel) DO UPDATE SET
         newest = CASE WHEN excluded.newest IS NULL OR cursors.newest >= excluded.newest THEN cursors.newest ELSE excluded.newest END,
         oldest = CASE WHEN excluded.oldest IS NULL OR cursors.oldest <= excluded.oldest THEN cursors.oldest ELSE excluded.oldest END,
         complete = MAX(cursors.complete, excluded.complete)`,
    )
    .run(id, idOrNull(edges.newest), idOrNull(edges.oldest), edges.complete === true ? 1 : 0)
}

/**
 * Sync-only: reconciles edges after authoritative history has closed every gap.
 * Unlike setCursorEdges, deletions may move either edge inward or clear it.
 * Coverage and freshness are preserved; an incomplete catch-up must not call this.
 */
export function reconcileCursorEdges(mirror: Mirror, channel: string): void {
  const id = idOrNull(channel)
  if (id === null) return
  mirror
    .prepare(
      `INSERT INTO cursors (channel, newest, oldest)
       SELECT ?, MAX(id), MIN(id) FROM messages WHERE channel = ?
       ON CONFLICT (channel) DO UPDATE SET newest = excluded.newest, oldest = excluded.oldest`,
    )
    .run(id, id)
}

/** Records when the channel's stored range was last checked against Discord. */
export function markRechecked(mirror: Mirror, channel: string, at: number): void {
  const id = idOrNull(channel)
  if (id === null) return
  mirror
    .prepare(
      "INSERT INTO cursors (channel, rechecked_at) VALUES (?, ?) ON CONFLICT (channel) DO UPDATE SET rechecked_at = excluded.rechecked_at",
    )
    .run(id, at)
}

/**
 * Marks the channel current as of `at`: a read serves it from the mirror while
 * that is recent. Only a sync run calls this; no ingest function sets
 * `synced_at`, so a stray live read never makes a lagging channel look complete.
 */
export function markCurrent(mirror: Mirror, channel: string, at: number): void {
  const id = idOrNull(channel)
  if (id === null) return
  mirror
    .prepare(
      "INSERT INTO cursors (channel, synced_at) VALUES (?, ?) ON CONFLICT (channel) DO UPDATE SET synced_at = excluded.synced_at",
    )
    .run(id, at)
}
