import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

/** Mode of the staging folders: owner only, since what is in them is not checked yet. */
const STAGING_MODE = 0o700

/** How old a leftover of an earlier call is, in milliseconds, before it is removed. */
const LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000

/** The folder one call downloads into, and the names it gives the files there. */
export type Staging = {
  /** Where the file of the item at `position` (counted from 1) is downloaded to. */
  fileFor(position: number): string
  /** Removes the folder and everything in it. */
  remove(): Promise<void>
}

/** Removes the entries of `root` that were last changed more than a day before `now`; one that cannot be removed stays. */
async function pruneLeftovers(root: string, now: number): Promise<void> {
  for (const name of await readdir(root).catch(() => [])) {
    const path = join(root, name)
    try {
      if (now - (await lstat(path)).mtimeMs > LEFTOVER_AGE_MS) await rm(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to remove: a later call tries again.
    }
  }
}

/**
 * Makes the staging folder `root` (a label's `incoming` or `outgoing`),
 * removes what earlier calls left there more than a day ago, and makes a
 * folder of its own for this call, named at random, which only the owner can
 * enter.
 */
export async function openStaging(root: string, now: number): Promise<Staging> {
  await mkdir(root, { recursive: true, mode: STAGING_MODE })
  await chmod(root, STAGING_MODE)
  await pruneLeftovers(root, now)
  const dir = join(root, randomBytes(8).toString("hex"))
  await mkdir(dir, { mode: STAGING_MODE })
  return {
    fileFor: (position) => join(dir, String(position).padStart(2, "0")),
    remove: () => rm(dir, { recursive: true, force: true }),
  }
}
