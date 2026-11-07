import { lstat } from "node:fs/promises"
import { isAbortError, isToolError } from "../errors"
import { abortError } from "../exec"
import { readAccount } from "../discord/account-meta"
import type { LabelPaths } from "../discord/labels"
import { maskTokens } from "../discord/mask"
import { getMeta, openMirrorForRead } from "../discord/mirror"
import { ACCOUNT_ID_META } from "../discord/mirror-meta"
import { isSnowflake } from "../discord/snowflake"
import {
  LAST_SYNC_AT_META,
  SYNC_FINISHED_AT_META,
  SYNC_STARTED_AT_META,
  SYNC_STATUS_META,
} from "../discord/sync-status"
import { type AccountRow, syncStatusSchema } from "./schemas"

/** Only finite, nonfuture Unix milliseconds represent usable local evidence. */
export function isoTime(value: number, now: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0 || value > now) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return null
  return date.toISOString()
}

/** Reads the login-verified identity; a mirror's legacy name is never authentication evidence. */
export async function readIdentity(row: AccountRow, paths: LabelPaths, now: number): Promise<void> {
  try {
    const identity = await readAccount(paths)
    if (!identity) row.reasons.push("identity_missing")
    else if (isoTime(identity.verifiedAt, now) === null) row.reasons.push("identity_invalid")
    else {
      row.id = identity.id
      row.name = maskTokens(identity.name)
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    row.reasons.push("identity_invalid")
  }
}

/** Reads existing mirror metadata only, refusing links and closing every opened connection. */
export async function readMirrorState(
  row: AccountRow,
  paths: LabelPaths,
  now: number,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const stat = await lstat(paths.mirror).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (signal?.aborted) throw abortError(signal)
    if (!stat) {
      row.reasons.push("mirror_missing")
      return
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      row.reasons.push("mirror_unavailable")
      return
    }
    const mirror = openMirrorForRead(paths.mirror)
    let meta: Record<string, string>
    try {
      meta = getMeta(mirror)
    } finally {
      mirror.close()
    }
    const accountId = meta[ACCOUNT_ID_META]
    if (accountId !== undefined) {
      if (!isSnowflake(accountId)) row.reasons.push("sync_state_invalid")
      else if (row.id !== null && accountId !== row.id) row.reasons.push("identity_mismatch")
    }
    if (meta[SYNC_STATUS_META] !== undefined) {
      const status = syncStatusSchema.safeParse(meta[SYNC_STATUS_META])
      if (status.success) row.sync_status = status.data
      else row.reasons.push("sync_state_invalid")
    }
    for (const key of [LAST_SYNC_AT_META, SYNC_STARTED_AT_META, SYNC_FINISHED_AT_META]) {
      const raw = meta[key]
      if (raw === undefined) continue
      const timestamp = raw.trim() === "" ? null : isoTime(Number(raw), now)
      if (timestamp === null) row.reasons.push("sync_state_invalid")
      else if (key === LAST_SYNC_AT_META) row.last_sync_at = timestamp
    }
    row.reasons = [...new Set(row.reasons)]
  } catch (error) {
    if (isAbortError(error)) throw error
    if (isToolError(error) && error.code === "not_found") row.reasons.push("mirror_missing")
    else if (isToolError(error) && error.code === "upstream_error" && error.message.includes("older version")) {
      row.reasons.push("mirror_outdated")
    } else row.reasons.push("mirror_unavailable")
  }
}
