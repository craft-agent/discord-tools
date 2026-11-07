import { chmodSync, closeSync, lstatSync, openSync, type BigIntStats } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ToolError } from "../errors"

/** Why a sync run did not start, or a removal cannot proceed: another holder has the lock. */
export const LOCK_HELD_REASON = "Another sync run for this account holds its sync lock."

/** Owner read and write only, like the rest of a label's state. */
const FILE_MODE = 0o600

/** SQLite's primary result code for a lock held elsewhere; extended codes keep it in the low byte. */
const SQLITE_BUSY = 5
const PRIMARY_CODE_MASK = 0xff

/** Which file a path named when it was checked. */
type FileIdentity = Pick<BigIntStats, "dev" | "ino">

function lstatLock(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false })
}

/** Creates the file, exclusively, only when it is absent: an existing file is never opened by a raw handle, whose close can drop SQLite's locks on it. */
function createIfAbsent(path: string): void {
  if (lstatLock(path)) return
  try {
    closeSync(openSync(path, "wx", FILE_MODE))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new ToolError("not_found", `The directory of the sync lock "${path}" does not exist.`, { cause: error })
    }
    if (code !== "EEXIST") throw error
  }
}

/** The identity of the lock file, which must be a regular file with one link and no symlink. */
function checkLockFile(path: string): FileIdentity {
  const stats = lstatLock(path)
  if (!stats) throw new ToolError("stale", `The sync lock "${path}" disappeared while it was being taken.`)
  if (!stats.isFile() || stats.nlink > 1n) {
    throw new ToolError("invalid_argument", `The sync lock "${path}" must be a regular file with a single link.`)
  }
  return { dev: stats.dev, ino: stats.ino }
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const { errcode, code } = error as { errcode?: unknown; code?: unknown }
  return (typeof errcode === "number" && (errcode & PRIMARY_CODE_MASK) === SQLITE_BUSY) || code === "SQLITE_BUSY"
}

/** Throws `stale` unless `path` still names the file that was locked. */
function checkStillThere(path: string, identity: FileIdentity): void {
  const stats = lstatLock(path)
  if (!stats || stats.dev !== identity.dev || stats.ino !== identity.ino) {
    throw new ToolError("stale", `The sync lock "${path}" was removed or replaced while it was being taken.`)
  }
}

/**
 * Takes the sync lock at `path`, or gives `undefined` when another connection
 * or process holds it. The returned function releases it, once; calling it
 * again does nothing, and the caller must keep it reachable while it holds the
 * lock, since a collected connection closes itself. The directory of `path`
 * must exist.
 *
 * The lock is a write transaction (`BEGIN IMMEDIATE`) held on a private SQLite
 * file, with no tables and no writes. Closing the connection or losing the
 * process releases it, so no pid is stored and no holder is ever guessed to be
 * dead. The file stays in place on release: contenders must always lock the
 * same file, and a deleted-and-recreated one would let two of them hold
 * different files at once. Removal detaches the whole directory instead, and a
 * lock whose file was removed or replaced meanwhile throws `stale`, never
 * recreating it.
 *
 * The file is created 0600 only when absent and must be a regular file with a
 * single link (`invalid_argument` otherwise). Any other SQLite failure, such as
 * a file that is not a database, is thrown and never read as a busy lock.
 */
export function acquireSyncLock(path: string): (() => void) | undefined {
  createIfAbsent(path)
  checkLockFile(path)
  chmodSync(path, FILE_MODE)
  const identity = checkLockFile(path)

  const db = new DatabaseSync(path)
  try {
    db.exec("PRAGMA busy_timeout = 0")
    db.exec("BEGIN IMMEDIATE")
    checkStillThere(path, identity)
  } catch (error) {
    db.close()
    if (isBusy(error)) return undefined
    throw error
  }

  let released = false
  return () => {
    if (released) return
    released = true
    db.close()
  }
}
