import { ToolError } from "../errors"
import { abortError } from "../exec"
import type { DiscordClient } from "./client"
import { ingestHistoryPage, type IngestCounts } from "./ingest"
import { isRecord } from "./ingest-values"
import { getMeta, inTransaction, setMeta, type Mirror } from "./mirror"
import { getCursor, markCurrent, markRechecked, reconcileCursorEdges, setCursorEdges } from "./mirror-cursors"
import { historyPage } from "./sync-page"
import { coveredHeadKey, pendingKey, verifiedMarkerKey, type PendingCatchup } from "./sync-status"
import { isSnowflake, snowflakeTime } from "./snowflake"

export const MAX_CHANNEL_PAGES = 5
export const SEED_PAGE_SIZE = 50
export const CATCHUP_PAGE_SIZE = 100
export const RECHECK_INTERVAL_MS = 30 * 60 * 1000
export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_RECHECK_CHANNELS = 2

export type SyncChannel = { id: string; head: string | null | undefined }
export type SyncContext = {
  mirror: Mirror
  client: DiscordClient
  me: string
  now: () => number
  signal?: AbortSignal
  add: (counts: IngestCounts) => void
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/** Refuses corrupt progress rather than silently skipping the gap it represents. */
function pendingFor(mirror: Mirror, id: string): PendingCatchup | undefined {
  const raw = getMeta(mirror)[pendingKey(id)]
  if (raw === undefined) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (
      isRecord(value) &&
      (value.anchor === "0" || isSnowflake(value.anchor)) &&
      isSnowflake(value.newest) &&
      isSnowflake(value.before) &&
      (!("marker" in value) || value.marker === null || isSnowflake(value.marker)) &&
      BigInt(value.newest) >= BigInt(value.before) &&
      BigInt(value.before) > BigInt(value.anchor)
    ) {
      return {
        anchor: value.anchor,
        newest: value.newest,
        before: value.before,
        ...("marker" in value ? { marker: value.marker as string | null } : {}),
      }
    }
  } catch {}
  throw new ToolError("upstream_error", "The stored sync progress is invalid.")
}

export function needsRecheck(ctx: SyncContext, channel: SyncChannel): boolean {
  const cursor = getCursor(ctx.mirror, channel.id)
  const head = channel.head ?? cursor?.newest
  return Boolean(
    head &&
    snowflakeTime(head) >= ctx.now() - ACTIVE_WINDOW_MS &&
    (cursor?.recheckedAt ?? 0) <= ctx.now() - RECHECK_INTERVAL_MS,
  )
}

/** Includes live-ingested messages whose ids have not yet reached the sync cursor. */
function mirroredNewest(mirror: Mirror, channel: string): string | null {
  const row = mirror
    .prepare("SELECT CAST(MAX(id) AS TEXT) AS newest FROM messages WHERE channel = ?")
    .get(BigInt(channel)) as { newest: string | null }
  return row.newest
}

/** Shared by freshness and recheck scheduling: metadata may retain the id of a deleted message. */
export function isChannelUnchanged(mirror: Mirror, channel: SyncChannel): boolean {
  if (channel.head === undefined) return false
  const meta = getMeta(mirror)
  if (meta[pendingKey(channel.id)] !== undefined) return false
  const cursor = getCursor(mirror, channel.id)
  if (!cursor || cursor.newest !== mirroredNewest(mirror, channel.id)) return false
  const covered = meta[coveredHeadKey(channel.id)]
  const marker = meta[verifiedMarkerKey(channel.id)]
  if (covered !== undefined && covered !== (cursor.newest ?? "0")) return false
  return marker === undefined
    ? cursor.newest === channel.head
    : covered !== undefined && marker === (channel.head ?? "0")
}

/** Commits each validated page with its continuation; returns whether the observed marker is now current. */
export async function syncChannel(ctx: SyncContext, channel: SyncChannel, recheck: boolean): Promise<boolean> {
  const { mirror, client, now } = ctx
  let cursor = getCursor(mirror, channel.id)
  let pending = pendingFor(mirror, channel.id)
  const coveredHead = getMeta(mirror)[coveredHeadKey(channel.id)]
  if (coveredHead !== undefined && coveredHead !== "0" && !isSnowflake(coveredHead)) {
    throw new ToolError("upstream_error", "The stored sync coverage is invalid.")
  }
  const unchanged = isChannelUnchanged(mirror, channel)
  if (!pending && unchanged && !recheck) {
    checkAbort(ctx.signal)
    inTransaction(mirror, () => markCurrent(mirror, channel.id, now()))
    return true
  }
  for (let pages = 0; pages < MAX_CHANNEL_PAGES; pages += 1) {
    checkAbort(ctx.signal)
    const before = pending?.before
    const marker = pending ? ("marker" in pending ? pending.marker : pending.newest) : channel.head
    const seed = !cursor?.newest && !pending && coveredHead === undefined
    const limit = seed || ((unchanged || recheck) && !pending) ? SEED_PAGE_SIZE : CATCHUP_PAGE_SIZE
    const observed = [cursor?.newest, channel.head, mirroredNewest(mirror, channel.id)]
      .filter(isSnowflake)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))[0]
    const value = await client.read("GET", `/channels/${channel.id}/messages`, {
      query: { limit, before },
      signal: ctx.signal,
    })
    checkAbort(ctx.signal)
    const page = historyPage(value, channel.id, limit, before, observed)
    const anchor = pending?.anchor ?? coveredHead ?? cursor?.newest
    const newest = pending?.newest ?? page.newest
    const caught =
      seed ||
      page.complete ||
      (anchor !== undefined && anchor !== null && page.oldest !== undefined && BigInt(page.oldest) <= BigInt(anchor))
    const next: PendingCatchup | undefined =
      !caught && anchor && newest && page.oldest
        ? { anchor, newest, before: page.oldest, ...(marker !== undefined ? { marker } : {}) }
        : undefined
    const { counts, current } = inTransaction(mirror, () => {
      const counts = ingestHistoryPage(mirror, { me: ctx.me, now: now() }, channel.id, page.messages, page.range)
      setMeta(mirror, { [pendingKey(channel.id)]: next ? JSON.stringify(next) : null })
      let current = false
      if (caught) {
        setCursorEdges(mirror, channel.id, {
          ...(newest ? { newest } : {}),
          ...(page.oldest ? { oldest: page.oldest } : {}),
          complete: page.complete,
        })
        reconcileCursorEdges(mirror, channel.id)
        setMeta(mirror, {
          [coveredHeadKey(channel.id)]: newest ?? "0",
          [verifiedMarkerKey(channel.id)]: marker === undefined ? null : (marker ?? "0"),
        })
        const reconciled = getCursor(mirror, channel.id)!.newest
        // A last-sent marker may name a deletion. Continuations retain the marker
        // originally observed; newer live arrivals still prevent freshness.
        current = reconciled === (newest ?? null) && marker !== undefined && marker === channel.head
        if (current) markCurrent(mirror, channel.id, now())
      }
      if (before === undefined) markRechecked(mirror, channel.id, now())
      return { counts, current }
    })
    ctx.add(counts)
    if (caught) return current
    pending = next
    cursor = getCursor(mirror, channel.id)
  }
  return false
}
