import { ToolError } from "../errors"
import { BudgetSpent, createDiscordClient, type DiscordClientOptions } from "./client"
import { ingestUsers, type IngestCounts } from "./ingest"
import { getMeta, inTransaction, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import { ACCOUNT_ID_META } from "./mirror-meta"
import {
  checkAbort,
  isChannelUnchanged,
  MAX_RECHECK_CHANNELS,
  needsRecheck,
  syncChannel,
  type SyncContext,
} from "./sync-channels"
import { verifySyncIdentity } from "./sync-identity"
import { readSyncList } from "./sync-list"
import { acquireSyncLock } from "./sync-lock"
import { selectChannels } from "./sync-selection"
import {
  LAST_SYNC_AT_META,
  SYNC_ERROR_META,
  SYNC_FINISHED_AT_META,
  SYNC_OFFSET_META,
  SYNC_STARTED_AT_META,
  SYNC_STATUS_META,
  type SyncResult,
  type SyncStatus,
} from "./sync-status"

export type { SyncResult } from "./sync-status"
export const MAX_SYNC_REQUESTS = 60

/** Error codes that end a channel or the run as partial instead of failing it. */
const PARTIAL_ERROR_CODES = ["forbidden", "not_found", "upstream_error", "rate_limited"]

/** Runs one bounded, account-locked sync. All counters include only committed ingest work. */
export async function runSync(options: DiscordClientOptions & { signal?: AbortSignal }): Promise<SyncResult> {
  checkAbort(options.signal)
  const list = await readSyncList(options.paths)
  const release = acquireSyncLock(options.paths.lock)
  const result: SyncResult = {
    status: release ? "complete" : "busy",
    requests: 0,
    channels: 0,
    stored: 0,
    deleted: 0,
    skipped: 0,
  }
  if (!release) return result
  let mirror: Mirror | undefined
  const now = options.now ?? Date.now
  const requested = options.budget ?? MAX_SYNC_REQUESTS
  const budget = Number.isNaN(requested)
    ? MAX_SYNC_REQUESTS
    : Math.max(0, Math.min(MAX_SYNC_REQUESTS, Math.floor(requested)))
  const client = createDiscordClient({ ...options, budget })
  let reason: string | null = null
  const partial = (code: string, skipped = 0) => {
    result.status = "partial"
    result.skipped += skipped
    reason ??= code
  }
  const add = (counts: IngestCounts) => {
    result.stored += counts.stored
    result.deleted += counts.deleted
    result.skipped += counts.skipped
  }
  const finish = (status: SyncStatus, error: string | null) => {
    if (!mirror) return
    inTransaction(mirror, () =>
      setMeta(mirror!, {
        [SYNC_STATUS_META]: status,
        [SYNC_ERROR_META]: error,
        [SYNC_FINISHED_AT_META]: now(),
        ...(status === "complete" ? { [LAST_SYNC_AT_META]: now() } : {}),
      }),
    )
  }
  try {
    const user = await verifySyncIdentity(client, options)
    mirror = openMirrorForWrite(options.paths.mirror)
    add(
      inTransaction(mirror, () => {
        setMeta(mirror!, {
          [ACCOUNT_ID_META]: user.id,
          [SYNC_STARTED_AT_META]: now(),
          [SYNC_STATUS_META]: "running",
          [SYNC_ERROR_META]: null,
        })
        return ingestUsers(mirror!, { me: user.id, now: now() }, [user])
      }),
    )
    const ctx: SyncContext = { mirror, client, me: user.id, now, signal: options.signal, add }
    const channels = await selectChannels(ctx, list, partial)
    const meta = getMeta(mirror)
    const offset = Math.max(0, Number(meta[SYNC_OFFSET_META]) || 0) % (channels.length || 1)
    const rotated = [...channels.slice(offset), ...channels.slice(0, offset)]
    let rechecks = 0
    for (const channel of rotated) {
      checkAbort(options.signal)
      const index = channels.findIndex((entry) => entry.id === channel.id)
      const requestsBefore = client.requests
      // Real attempts rotate even on failure; an unattempted budget stop is restored below.
      inTransaction(mirror, () =>
        setMeta(mirror!, {
          [SYNC_OFFSET_META]: (index + 1) % channels.length,
        }),
      )
      result.channels += 1
      const recheck =
        rechecks < MAX_RECHECK_CHANNELS && isChannelUnchanged(mirror, channel) && needsRecheck(ctx, channel)
      if (recheck) rechecks += 1
      try {
        if (!(await syncChannel(ctx, channel, recheck))) partial("incomplete_history")
      } catch (error) {
        if (error instanceof BudgetSpent && client.requests === requestsBefore) {
          inTransaction(mirror, () => setMeta(mirror!, { [SYNC_OFFSET_META]: index }))
        }
        if (options.signal?.aborted) throw error
        if (error instanceof ToolError && PARTIAL_ERROR_CODES.includes(error.code)) {
          partial(error.code, 1)
          continue
        }
        throw error
      }
    }
    checkAbort(options.signal)
    finish(result.status === "complete" ? "complete" : "partial", reason)
  } catch (error) {
    if (options.signal?.aborted) {
      finish("cancelled", "cancelled")
      throw error
    }
    if (error instanceof BudgetSpent) {
      partial("budget_spent")
      finish("partial", reason)
    } else if (error instanceof ToolError && PARTIAL_ERROR_CODES.includes(error.code)) {
      partial(error.code)
      finish("partial", reason)
    } else {
      finish(
        error instanceof ToolError && error.code === "unauthenticated" ? "rejected" : "failed",
        error instanceof ToolError ? error.code : "internal_error",
      )
      throw error
    }
  } finally {
    result.requests = client.requests
    try {
      mirror?.close()
    } finally {
      release()
    }
  }
  return result
}
