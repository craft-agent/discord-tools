import { delimiter, isAbsolute, resolve } from "node:path"
import { ToolError } from "../core"
import { expandTilde, homeDir, type SettingText } from "./state-dir"

const MAX_SEND_DIRS = 20
const MIN_SEND_MB = 1
const MAX_SEND_MB = 500
const DEFAULT_SEND_MB = 10
const WHOLE_NUMBER = /^\d+$/

/** A list of directories given as delimited text or as string entries, with its source for error messages. */
export type SendDirsInput = SettingText | { entries: readonly string[]; source: string }

/**
 * Resolves the absolute paths of the directories files may be sent from.
 *
 * Splits delimited text on the platform's path-list separator, trims each
 * entry, drops empty entries, and expands a leading `~`. Returns `undefined`
 * when unset or empty so tools fall back to the call's working directory.
 * Creates nothing and checks no real path.
 */
export function resolveSendDirs(
  given: SendDirsInput | undefined,
  env: Record<string, string | undefined>,
): string[] | undefined {
  if (given === undefined) return undefined

  const home = homeDir(env)
  const items = "text" in given ? given.text.split(delimiter) : given.entries
  const resolved: string[] = []

  for (const item of items) {
    const text = item.trim()
    if (!text) continue
    const expanded = expandTilde(text, home)
    if (!isAbsolute(expanded)) {
      throw new ToolError("invalid_argument", `${given.source} must be an absolute path.`)
    }
    resolved.push(resolve(expanded))
  }

  if (resolved.length > MAX_SEND_DIRS) {
    throw new ToolError("invalid_argument", `${given.source} may list at most ${MAX_SEND_DIRS} directories.`)
  }

  return resolved.length > 0 ? resolved : undefined
}

/** Resolves the size, in megabytes, a file being sent may have: a whole number from 1 to 500, 10 when not given. */
export function resolveSendMaxMb(given: SettingText | undefined): number {
  if (given === undefined) return DEFAULT_SEND_MB
  const text = given.text.trim()
  const megabytes = WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN
  if (!(megabytes >= MIN_SEND_MB && megabytes <= MAX_SEND_MB)) {
    throw new ToolError("invalid_argument", `send_max_mb must be a whole number from ${MIN_SEND_MB} to ${MAX_SEND_MB}`)
  }
  return megabytes
}
