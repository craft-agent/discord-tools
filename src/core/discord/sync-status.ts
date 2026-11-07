/** Sync-owned mirror metadata. Only a wholly successful run updates LAST_SYNC_AT_META. */
export const SYNC_STARTED_AT_META = "sync_started_at"
export const SYNC_FINISHED_AT_META = "sync_finished_at"
export const SYNC_STATUS_META = "sync_status"
export const SYNC_ERROR_META = "sync_error"
export const LAST_SYNC_AT_META = "last_sync_at"
export const SYNC_OFFSET_META = "sync_selection_offset"

export type SyncStatus = "running" | "complete" | "partial" | "rejected" | "failed" | "cancelled"
export type SyncResult = {
  status: "complete" | "partial" | "busy"
  requests: number
  channels: number
  stored: number
  deleted: number
  skipped: number
}

/** A gap to fill before the cursor may advance to the saved head; anchor "0" means previously empty history. */
export type PendingCatchup = { anchor: string; newest: string; before: string; marker?: string | null }

export function pendingKey(channel: string): string {
  return `sync_pending_${channel}`
}

/** Last head whose gap was filled, separate from higher live-ingested cursor edges; "0" means empty. */
export function coveredHeadKey(channel: string): string {
  return `sync_covered_head_${channel}`
}

/** Observed last-sent marker verified by completed history, even if that message was deleted; "0" means null. */
export function verifiedMarkerKey(channel: string): string {
  return `sync_verified_marker_${channel}`
}
