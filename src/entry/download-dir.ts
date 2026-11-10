import { isAbsolute, resolve } from "node:path"
import { ToolError } from "../core"
import type { EntryProfile } from "./profile"
import { expandTilde, homeDir, type SettingText } from "./state-dir"

const DOWNLOADS_DIR = "Downloads"
const MIN_DOWNLOAD_MB = 1
const MAX_DOWNLOAD_MB = 500
const DEFAULT_DOWNLOAD_MB = 100
const WHOLE_NUMBER = /^\d+$/

/**
 * Resolves the absolute path to the directory where received files are saved.
 *
 * Expands a leading `~` in the given text; when none is given, falls back to
 * `<home>/Downloads/<profile.name>`. Creates nothing and checks no real path.
 */
export function resolveDownloadDir(
  given: SettingText | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): string {
  const home = homeDir(env)

  if (given !== undefined) {
    const text = given.text.trim()
    const expanded = expandTilde(text, home)
    if (!text || !isAbsolute(expanded)) {
      throw new ToolError("invalid_argument", `${given.source} must be an absolute path.`)
    }
    return resolve(expanded)
  }

  return resolve(home, DOWNLOADS_DIR, profile.name)
}

/** Resolves the size, in megabytes, a received file may have: a whole number from 1 to 500, 100 when not given. */
export function resolveDownloadMaxMb(given: SettingText | undefined): number {
  if (given === undefined) return DEFAULT_DOWNLOAD_MB
  const text = given.text.trim()
  const megabytes = WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN
  if (!(megabytes >= MIN_DOWNLOAD_MB && megabytes <= MAX_DOWNLOAD_MB)) {
    throw new ToolError(
      "invalid_argument",
      `download_max_mb must be a whole number from ${MIN_DOWNLOAD_MB} to ${MAX_DOWNLOAD_MB}`,
    )
  }
  return megabytes
}
