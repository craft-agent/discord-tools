import { chmod, lstat, mkdir, readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { ToolError } from "../errors"

/** The label used when none is given. */
export const DEFAULT_LABEL = "default"

/** 1 to 24 lowercase letters, digits and `_`, starting and ending with a letter or digit. */
export const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9_]{0,22}[a-z0-9])?$/

/** Maximum character length of a bad label shown in error messages. */
const MAX_BAD_LABEL_PREVIEW = 40

/** Mode of private state directories: owner only. */
const DIR_MODE = 0o700

function quoteBadLabel(value: string): string {
  const truncated = value.length > MAX_BAD_LABEL_PREVIEW ? `${value.slice(0, MAX_BAD_LABEL_PREVIEW)}…` : value
  return JSON.stringify(truncated)
}

/** Whether `text` is a valid label name. */
export function isLabel(text: string): boolean {
  return typeof text === "string" && LABEL_PATTERN.test(text)
}

/** Returns the label, or throws `invalid_argument` stating the rule. */
export function checkLabel(label: string): string {
  if (!isLabel(label)) {
    throw new ToolError(
      "invalid_argument",
      `Invalid label ${quoteBadLabel(label)}: a label must be 1 to 24 lowercase letters, digits and "_", starting and ending with a letter or digit.`,
    )
  }
  return label
}

/** Where one label keeps its state; every path is inside `dir`. */
export type LabelPaths = {
  label: string
  /** `<stateDir>/<label>` */
  dir: string
  /** The token file, when the account's token is not in the environment. */
  token: string
  /** The record of a token Discord rejected. */
  auth: string
  /** The client identity kept between runs (launch ids). */
  client: string
  /** The label's SQLite mirror. */
  mirror: string
  /** The sync service's lock. */
  lock: string
  /** The short-lived copies of files being sent or received. */
  transfers: string
}

/** Resolves the state paths for `label`; throws `invalid_argument` for a bad label and `internal_error` for a relative `stateDir`. */
export function labelPaths(stateDir: string, label: string): LabelPaths {
  if (!isAbsolute(stateDir)) {
    throw new ToolError("internal_error", `State directory must be absolute; got ${JSON.stringify(stateDir)}.`)
  }
  checkLabel(label)
  const dir = join(stateDir, label)
  return {
    label,
    dir,
    token: join(dir, "token"),
    auth: join(dir, "auth.json"),
    client: join(dir, "client.json"),
    mirror: join(dir, "mirror.sqlite"),
    lock: join(dir, "sync.lock"),
    transfers: join(dir, "transfers"),
  }
}

/**
 * The labels that have a state directory, sorted.
 *
 * A missing `stateDir` gives `[]`. Entries that are not real directories
 * (such as symlinks) or whose names are not valid labels are skipped.
 */
export async function listLabels(stateDir: string): Promise<string[]> {
  let entries: string[]
  try {
    const dirEntries = await readdir(stateDir, { withFileTypes: true })
    entries = dirEntries.filter((e) => isLabel(e.name)).map((e) => e.name)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return []
    }
    throw err
  }

  const valid: string[] = []
  for (const name of entries) {
    try {
      const stat = await lstat(join(stateDir, name))
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        valid.push(name)
      }
    } catch {
      // Entry may have been removed concurrently; skip it.
    }
  }
  return valid.sort()
}

/**
 * Picks the label a call works on, from its `account` argument:
 * - given: checked, and it must be among listLabels, else not_found naming the label and listing the known ones (or saying none is signed in);
 * - absent with exactly one label: that one;
 * - absent with none: not_found, "No Discord account is signed in yet; sign one in first.";
 * - absent with several: invalid_argument, "Several Discord accounts are signed in; name one with `account`: a, b."
 */
export async function pickLabel(stateDir: string, account: string | undefined): Promise<LabelPaths> {
  const labels = await listLabels(stateDir)

  if (account !== undefined) {
    const label = checkLabel(account)
    if (!labels.includes(label)) {
      const known = labels.length > 0 ? `known accounts: ${labels.join(", ")}.` : "no Discord account is signed in yet."
      throw new ToolError("not_found", `Discord account "${label}" was not found; ${known}`)
    }
    return labelPaths(stateDir, label)
  }

  if (labels.length === 0) {
    throw new ToolError("not_found", "No Discord account is signed in yet; sign one in first.")
  }

  if (labels.length > 1) {
    throw new ToolError(
      "invalid_argument",
      `Several Discord accounts are signed in; name one with \`account\`: ${labels.join(", ")}.`,
    )
  }

  return labelPaths(stateDir, labels[0]!)
}

/**
 * Creates `stateDir` and the label's directory with mode 0700 (chmod both to 0700 even if they existed,
 * since mkdir's mode is masked by umask), refusing (invalid_argument) when the label path exists and
 * is not a real directory (e.g. a symlink). Returns the paths.
 */
export async function ensureLabelDir(stateDir: string, label: string): Promise<LabelPaths> {
  const paths = labelPaths(stateDir, label)

  const stateStat = await lstat(stateDir).catch(() => undefined)
  if (stateStat && !stateStat.isDirectory()) {
    throw new ToolError("invalid_argument", `State directory "${stateDir}" exists and is not a directory.`)
  }

  const dirStat = await lstat(paths.dir).catch(() => undefined)
  if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" exists and is not a directory.`)
  }

  await mkdir(paths.dir, { recursive: true, mode: DIR_MODE })
  await chmod(stateDir, DIR_MODE)
  await chmod(paths.dir, DIR_MODE)

  return paths
}
