import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { writePrivateFile } from "./private-file"
import { readSyncList, SYNC_LIST_FILE, validateSyncList, type SyncList } from "./sync-list"
import { acquireSyncLock } from "./sync-lock"

/** The list's own lock, in the label's directory: never `sync.lock`, so a change never waits for a sync run. */
export const SYNC_LIST_LOCK_FILE = "sync-list.lock"

/** How long to wait between two tries at a held list lock. */
const LOCK_RETRY_MS = 50

/** How long to keep trying at a held list lock before giving up; a change holds it for a few milliseconds. */
const LOCK_WAIT_MS = 2000

/** How a change waits for the list lock, and when it stops. */
export type ChangeSyncListOptions = {
  signal?: AbortSignal
  /** The wait between tries; the default is for callers, tests shorten it. */
  retryMs?: number
  /** The longest wait in all; the default is for callers, tests shorten it. */
  waitMs?: number
}

/** The sync list after a change, and whether the file was written. */
export type SyncListChange = { list: SyncList; changed: boolean }

/** Takes the list lock, trying again for a short while; `stale` when it stays held. */
async function acquireListLock(paths: LabelPaths, options: ChangeSyncListOptions): Promise<() => void> {
  const { signal, retryMs = LOCK_RETRY_MS, waitMs = LOCK_WAIT_MS } = options
  const lockPath = join(paths.dir, SYNC_LIST_LOCK_FILE)
  for (let waited = 0; ; waited += retryMs) {
    const release = acquireSyncLock(lockPath)
    if (release) return release
    if (waited >= waitMs) {
      throw new ToolError("stale", "Another change to this account's sync list is in progress; try again.")
    }
    await sleep(retryMs, undefined, signal ? { signal } : undefined)
  }
}

/**
 * Changes the label's sync list under the list's own lock: reads it, gives it
 * to `change`, and writes what comes back whole and atomically. `change`
 * returns `undefined`, or a list equal to the current one, for no change; then
 * nothing is written. A list that fails `validateSyncList` is refused
 * (`invalid_argument`) and the file stays as it was. A lock that stays held
 * past the wait throws `stale`; a change to the list never touches `sync.lock`.
 */
export async function changeSyncList(
  paths: LabelPaths,
  change: (list: SyncList) => SyncList | undefined,
  options: ChangeSyncListOptions = {},
): Promise<SyncListChange> {
  const release = await acquireListLock(paths, options)
  try {
    const current = await readSyncList(paths)
    const next = change(current)
    if (next === undefined || isDeepStrictEqual(next, current)) return { list: current, changed: false }
    const list = validateSyncList(next)
    await writePrivateFile(join(paths.dir, SYNC_LIST_FILE), `${JSON.stringify(list, null, 2)}\n`)
    return { list, changed: true }
  } finally {
    release()
  }
}
