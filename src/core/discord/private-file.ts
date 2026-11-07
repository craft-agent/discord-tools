import { randomBytes } from "node:crypto"
import { open, readFile, rename, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/** Bytes of randomness in a temporary file's name. */
const TEMP_SUFFIX_BYTES = 8

/** Mode of private files: owner read/write only. */
const PRIVATE_FILE_MODE = 0o600

/**
 * Writes `content` to `path` with mode 0600, atomically: a temporary file
 * beside it is written, synced and renamed over `path`, so a reader sees the
 * old file or the new one and never part of either. The directory must exist.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `${basename(path)}.${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}.tmp`)
  const handle = await open(temp, "wx", PRIVATE_FILE_MODE)
  try {
    try {
      // The mode given to open is masked by the umask; chmod sets it exactly.
      await handle.chmod(PRIVATE_FILE_MODE)
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** The parsed JSON in `path`, or `undefined` when the file is missing, unreadable or not JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return undefined
  }
}
