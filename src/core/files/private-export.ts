import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, copyFile, link, mkdir, open, unlink } from "node:fs/promises"
import { basename, join } from "node:path"
import { ToolError } from "../errors"
import type { ToolContext } from "../tool"
import { downloadSettings, ensureDownloadDir } from "./download-dir"
import { errorCode } from "./errno"
import { numberedName } from "./names"
import { COPIES_MAX, NEW_FILE_FLAGS, NO_HARD_LINKS, PART_PREFIX, PART_RANDOM_BYTES } from "./publish"

/** The folder of the download directory that holds exports. */
const EXPORTS_FOLDER = "exports"

/** Mode of the exports folder: an export can hold private chats, so only its owner may enter. */
export const EXPORT_FOLDER_MODE = 0o700

/** Mode of an export file: readable and writable by its owner alone, with no execute bit. */
export const EXPORT_FILE_MODE = 0o600

/** A folder opened as itself: a link in its place, or anything that is not a folder, is never opened. */
const FOLDER_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

/**
 * The folder exports go to, `<download_dir>/exports`, ready to write into.
 * The download directory is made and checked as for received files (it is
 * never, nor holds, the state or install directory); the folder is made when
 * it is not there, with mode 0700 whatever the umask. One that is there must
 * be a plain folder, never a link, and gets mode 0700 too, since exports must
 * not be readable by others: that is the one change made to a folder that was
 * already there, and it fails as `invalid_argument` when the folder is not
 * the user's own. `internal_error` when the entry point gave no download
 * directory.
 */
export async function exportsDir(ctx: ToolContext): Promise<string> {
  const { dir } = downloadSettings(ctx)
  await ensureDownloadDir(dir, ctx)
  const path = join(dir, EXPORTS_FOLDER)
  try {
    await mkdir(path, { mode: EXPORT_FOLDER_MODE })
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new ToolError("invalid_argument", `The exports folder ${path} cannot be made (${errorCode(error)}).`)
    }
  }
  const folder = await open(path, FOLDER_FLAGS).catch((error: unknown) => {
    throw new ToolError(
      "invalid_argument",
      `${path} is not a plain folder (a link or a file) and cannot be used for exports (${errorCode(error)}).`,
    )
  })
  try {
    await folder.chmod(EXPORT_FOLDER_MODE)
  } catch (error) {
    throw new ToolError("invalid_argument", `The exports folder ${path} cannot be made private (${errorCode(error)}).`)
  } finally {
    await folder.close()
  }
  return path
}

/** Gives `part` its final name without replacing anything: by a hard link, else by an exclusive copy. A taken name is `EEXIST` either way. */
async function place(part: string, path: string, linkFile: typeof link): Promise<void> {
  try {
    await linkFile(part, path)
  } catch (error) {
    if (!NO_HARD_LINKS.has(String(errorCode(error)))) throw error
    await copyFile(part, path, constants.COPYFILE_EXCL)
    await chmod(path, EXPORT_FILE_MODE)
  }
}

/**
 * Writes `content` as a new file of mode 0600 named `name` in `folder` (see
 * `exportsDir`), or `name-2`, `name-3`, … if that is taken, and returns its
 * path. The file is written and synced in full under a temporary name, then
 * given its final one by a hard link (an exclusive copy where the file system
 * has none), so a reader never finds half an export and nothing is ever
 * replaced or followed: a file, a folder or a link of the name makes the next
 * number. The temporary file is removed whatever happens. `linkFile` makes the
 * hard link; it is `link` unless a test gives another.
 */
export async function writeExport(
  folder: string,
  name: string,
  content: string,
  linkFile: typeof link = link,
): Promise<string> {
  if (name === "" || basename(name) !== name || name.startsWith(".")) {
    throw new ToolError("internal_error", `${JSON.stringify(name)} is not a file name for an export.`)
  }
  const part = join(folder, `${PART_PREFIX}${randomBytes(PART_RANDOM_BYTES).toString("hex")}`)
  try {
    const handle = await open(part, NEW_FILE_FLAGS, EXPORT_FILE_MODE)
    try {
      await handle.chmod(EXPORT_FILE_MODE)
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let n = 1; n <= COPIES_MAX; n++) {
      const path = join(folder, n === 1 ? name : numberedName(name, n))
      try {
        await place(part, path, linkFile)
        return path
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
      }
    }
    throw new Error(`there are already ${COPIES_MAX} files named like ${name}`)
  } finally {
    await unlink(part).catch(() => {})
  }
}
