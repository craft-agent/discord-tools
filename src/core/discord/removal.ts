import { randomUUID } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { isWithin } from "../paths"
import { labelPaths, type LabelPaths } from "./labels"
import { LOCK_HELD_REASON, acquireSyncLock } from "./sync-lock"

/** What removing one label needs; `uninstall` stops its scheduled service and is the caller's. */
export type RemoveLabelOptions = {
  stateDir: string
  label: string
  uninstall: () => Promise<void>
}

/** The label directory as it was found, to tell it from anything put in its place. */
type DirectoryIdentity = Pick<BigIntStats, "dev" | "ino">

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function isSameDirectory(stats: BigIntStats | undefined, identity: DirectoryIdentity): boolean {
  return stats !== undefined && stats.isDirectory() && stats.dev === identity.dev && stats.ino === identity.ino
}

/** The label's directory before anything is changed: `not_found` when missing, `invalid_argument` when it is a symlink or not a directory. */
async function findLabelDir(paths: LabelPaths): Promise<DirectoryIdentity> {
  const stats = await lstatIfPresent(paths.dir)
  if (!stats) throw new ToolError("not_found", `Discord account "${paths.label}" was not found; nothing was removed.`)
  if (!stats.isDirectory()) {
    throw new ToolError(
      "invalid_argument",
      `Label directory "${paths.dir}" is not a real directory; nothing was removed.`,
    )
  }
  return { dev: stats.dev, ino: stats.ino }
}

/** Throws `stale` unless the label's path still names the directory found first, inside the state root. */
async function requireSameDir(paths: LabelPaths, stateDir: string, identity: DirectoryIdentity): Promise<void> {
  if (!isSameDirectory(await lstatIfPresent(paths.dir), identity) || !(await isWithin(paths.dir, stateDir))) {
    throw new ToolError(
      "stale",
      `The state of "${paths.label}" changed while it was being removed; nothing was deleted. Check it and remove it again.`,
    )
  }
}

/**
 * Removes one label's local state, after `uninstall` has stopped its
 * scheduled service. This deletes local files only, not anything on Discord.
 *
 * The label must exist as a real directory (`not_found`, `invalid_argument`),
 * checked before `uninstall` runs; a failing `uninstall` propagates and leaves
 * the state. The sync lock is then taken once: a busy label throws
 * `invalid_argument` and stays intact. Under the lock the directory, which
 * must still be the one first found, is renamed out of the label namespace
 * into the state root, so a run waiting on the lock cannot write into state
 * being removed, and only that detached directory is deleted. A directory
 * missing or replaced meanwhile is `stale` and nothing is deleted. A failed
 * deletion throws `upstream_error` naming the detached directory and rolls
 * nothing back, since the label may belong to a new account by then.
 */
export async function removeLabel({ stateDir, label, uninstall }: RemoveLabelOptions): Promise<void> {
  const paths = labelPaths(stateDir, label)
  const identity = await findLabelDir(paths)
  await uninstall()

  await requireSameDir(paths, stateDir, identity)
  const release = acquireSyncLock(paths.lock)
  if (!release) {
    throw new ToolError(
      "invalid_argument",
      `${LOCK_HELD_REASON} Stop the foreground sync of "${label}", then remove it again; its state was left intact.`,
    )
  }

  const detached = join(stateDir, `.removed-${label}-${randomUUID()}`)
  try {
    await requireSameDir(paths, stateDir, identity)
    await rename(paths.dir, detached)
  } finally {
    release()
  }

  if (!isSameDirectory(await lstatIfPresent(detached), identity)) {
    throw new ToolError(
      "stale",
      `The state of "${label}" changed while it was being removed; "${detached}" was left as it is.`,
    )
  }
  try {
    await rm(detached, { recursive: true, force: true })
  } catch (error) {
    throw new ToolError(
      "upstream_error",
      `The state of "${label}" was detached but not fully deleted; delete "${detached}" by hand: ${(error as Error).message}`,
      { cause: error },
    )
  }
}
