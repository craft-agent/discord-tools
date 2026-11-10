import { mkdir, rm } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { ToolError } from "../errors"
import { overlapsPrivate } from "../paths"
import type { ToolContext } from "../tool"

/** Mode of the download directory and of each message's folder. */
export const FOLDER_MODE = 0o755

/** The two settings a save needs, as the entry point resolved them. */
export type DownloadSettings = { dir: string; maxMb: number }

/** The download settings of a call; `internal_error` when the entry point gave none, since it always does. */
export function downloadSettings(ctx: ToolContext): DownloadSettings {
  const { downloadDir, downloadMaxMb } = ctx
  if (downloadDir === undefined || !isAbsolute(downloadDir) || downloadMaxMb === undefined || !(downloadMaxMb > 0)) {
    throw new ToolError("internal_error", "Saving files requires an absolute download directory and a size limit.")
  }
  return { dir: downloadDir, maxMb: downloadMaxMb }
}

/**
 * Makes the download directory, then refuses it as `invalid_argument` when, by
 * real path, it is, holds or sits inside the state directory or the tools'
 * install directory: files received from others never go into the place the
 * tools keep their own.
 */
export async function ensureDownloadDir(dir: string, ctx: ToolContext): Promise<void> {
  let created: string | undefined
  try {
    created = await mkdir(dir, { recursive: true, mode: FOLDER_MODE })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an error"
    throw new ToolError("invalid_argument", `The download directory ${dir} cannot be made (${code}).`)
  }
  const overlap = await overlapsPrivate(dir, ctx)
  if (overlap) {
    // What was just made must not stay: a folder in the state directory would read as another account.
    if (created !== undefined) await rm(created, { recursive: true, force: true })
    throw new ToolError(
      "invalid_argument",
      `The download directory ${dir} is, holds or is inside ${overlap.what} ${overlap.root}; choose another with download_dir.`,
    )
  }
}
