import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { isRecord } from "./ingest-values"
import type { LabelPaths } from "./labels"
import { isSnowflake } from "./snowflake"

export const SYNC_LIST_FILE = "sync.json"
export const MAX_SYNC_SERVERS = 10
export const MAX_SYNC_CHANNELS = 30
export const WHOLE_SERVER_CHANNELS = 10
const MAX_SYNC_LIST_BYTES = 64 * 1024

export type SyncServer = { id: string; channels?: string[]; exclude?: string[] }
export type SyncList = { servers: SyncServer[] }

function invalid(): never {
  throw new ToolError("invalid_argument", "The sync list must contain unique server and channel ids within its limits.")
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isSnowflake) || new Set(value).size !== value.length) invalid()
  return value
}

/** Validates the complete selection before any network request. Unknown fields and duplicate targets are refused. */
export function validateSyncList(value: unknown): SyncList {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "servers") || !Array.isArray(value.servers))
    invalid()
  if (value.servers.length > MAX_SYNC_SERVERS) invalid()
  const servers = new Set<string>()
  const channels = new Set<string>()
  let slots = 0
  const selections = value.servers.map((entry): SyncServer => {
    if (!isRecord(entry) || !isSnowflake(entry.id) || servers.has(entry.id)) invalid()
    if (Object.keys(entry).some((key) => !["id", "channels", "exclude"].includes(key))) invalid()
    servers.add(entry.id)
    const selected = "channels" in entry ? ids(entry.channels) : undefined
    const exclude = "exclude" in entry ? ids(entry.exclude) : undefined
    for (const id of selected ?? []) {
      if (channels.has(id)) invalid()
      channels.add(id)
    }
    slots += selected?.length ?? WHOLE_SERVER_CHANNELS
    if (slots > MAX_SYNC_CHANNELS) invalid()
    return { id: entry.id, ...(selected ? { channels: selected } : {}), ...(exclude ? { exclude } : {}) }
  })
  return { servers: selections }
}

/** Reads a regular, non-symlink selection file; absence means DMs only. */
export async function readSyncList(paths: LabelPaths): Promise<SyncList> {
  let file
  try {
    file = await open(join(paths.dir, SYNC_LIST_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [] }
    return invalid()
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SYNC_LIST_BYTES) invalid()
    return validateSyncList(JSON.parse(await file.readFile("utf8")))
  } catch {
    return invalid()
  } finally {
    await file.close()
  }
}
