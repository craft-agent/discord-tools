import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import type { ToolOptions, ToolOptionValue } from "../core"
import { DEFAULT_SEND_MAX_MB } from "../core/sends/outgoing"
import type { EntryProfile } from "./profile"

/** Where state, received files, and sendable files live, and how large received or sent files may be, all resolved. */
export type StorageSettings = {
  state_dir: string
  download_dir: string
  download_max_mb: number
  send_dirs?: string[]
  send_max_mb: number
}

/** The parts of a call's context that the storage settings give. */
export type StorageContext = {
  stateDir?: string
  downloadDir?: string
  downloadMaxMb?: number
  sendDirs?: readonly string[]
  sendMaxMb?: number
}

const DOWNLOADS_DIR = "Downloads"
const DEFAULT_DOWNLOAD_MB = 100

/** Hands the storage settings to a tool as the context fields they become. */
export function storageContext(settings: StorageSettings): StorageContext {
  return {
    stateDir: settings.state_dir,
    downloadDir: settings.download_dir,
    downloadMaxMb: settings.download_max_mb,
    ...(settings.send_dirs !== undefined && { sendDirs: settings.send_dirs }),
    sendMaxMb: settings.send_max_mb,
  }
}

function homeDir(env: Record<string, string | undefined>): string {
  const envHome = env.HOME
  return envHome && isAbsolute(envHome) ? envHome : homedir()
}

function stateDirDefault(env: Record<string, string | undefined>, home: string, profile: EntryProfile): string {
  const xdg = env.XDG_STATE_HOME
  return xdg && isAbsolute(xdg) ? resolve(xdg, profile.name) : resolve(home, ".local", "state", profile.name)
}

function textOf(value: ToolOptionValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberOf(value: ToolOptionValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined
}

function listOf(value: ToolOptionValue | undefined): string[] | undefined {
  return typeof value === "object" && value.length > 0 ? [...value] : undefined
}

/**
 * Resolves the package's own storage settings from the tool options the
 * starter's parsers read (`state_dir`, `download_dir`, `download_max_mb`,
 * `send_dirs`, `send_max_mb`), filling in what is unset: the state directory is
 * `$XDG_STATE_HOME/<profile.name>` (when absolute) or
 * `<home>/.local/state/<profile.name>`, the download directory
 * `<home>/Downloads/<profile.name>`, the download limit 100 MB and the send
 * limit `DEFAULT_SEND_MAX_MB`. The home directory is `$HOME` when absolute, else
 * the user's. Send directories stay absent when unset, so tools fall back to the
 * call's working directory. Creates nothing and checks no real path.
 */
export function storageSettings(
  options: ToolOptions,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): StorageSettings {
  const home = homeDir(env)
  const sendDirs = listOf(options.send_dirs)
  return {
    state_dir: textOf(options.state_dir) ?? stateDirDefault(env, home, profile),
    download_dir: textOf(options.download_dir) ?? resolve(home, DOWNLOADS_DIR, profile.name),
    download_max_mb: numberOf(options.download_max_mb) ?? DEFAULT_DOWNLOAD_MB,
    ...(sendDirs !== undefined && { send_dirs: sendDirs }),
    send_max_mb: numberOf(options.send_max_mb) ?? DEFAULT_SEND_MAX_MB,
  }
}
