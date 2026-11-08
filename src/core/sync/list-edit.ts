import { ToolError } from "../errors"
import {
  MAX_SYNC_CHANNELS,
  MAX_SYNC_SERVERS,
  WHOLE_SERVER_CHANNELS,
  type SyncList,
  type SyncServer,
} from "../discord/sync-list"

/** The most channels one server's entry excludes; it keeps the list file far below the size a read accepts. */
export const MAX_EXCLUDED_CHANNELS = 100

/** Where to look for quiet entries to make room. */
const MAKE_ROOM = "discord_sync_read method suggest lists quiet entries; discord_sync_remove drops them."

/** The channel slots an entry uses: one per named channel, or a whole server's share. */
export function entrySlots(entry: SyncServer): number {
  return entry.channels?.length ?? WHOLE_SERVER_CHANNELS
}

/** `ids` with `added` after them; an id already there keeps its place. */
export function mergeIds(ids: readonly string[] | undefined, added: readonly string[]): string[] {
  return [...new Set([...(ids ?? []), ...added])]
}

/** `ids` without `dropped`, in order. */
export function dropIds(ids: readonly string[] | undefined, dropped: readonly string[]): string[] {
  return (ids ?? []).filter((id) => !dropped.includes(id))
}

/** An entry for server `id`; an empty `exclude` is left out. */
export function entryOf(id: string, channels: string[] | undefined, exclude: string[]): SyncServer {
  return { id, ...(channels ? { channels } : {}), ...(exclude.length > 0 ? { exclude } : {}) }
}

/** The list with the entry of server `id` replaced by `entry`, appended when there was none, or dropped when `entry` is `undefined`. */
export function replaceEntry(list: SyncList, id: string, entry: SyncServer | undefined): SyncList {
  const found = list.servers.some((candidate) => candidate.id === id)
  if (!entry) return { servers: list.servers.filter((candidate) => candidate.id !== id) }
  if (!found) return { servers: [...list.servers, entry] }
  return { servers: list.servers.map((candidate) => (candidate.id === id ? entry : candidate)) }
}

/**
 * Refuses a list the limits would refuse, saying how much is used and where
 * to make room (`invalid_argument`): more servers than the list takes, more
 * channel slots, or more excluded channels on server `id` than an entry keeps.
 */
export function checkRoom(list: SyncList, id: string): void {
  if (list.servers.length > MAX_SYNC_SERVERS) {
    throw new ToolError(
      "invalid_argument",
      `The sync list would follow ${list.servers.length} servers, and takes at most ${MAX_SYNC_SERVERS}. ${MAKE_ROOM}`,
    )
  }
  const used = list.servers.reduce((sum, entry) => sum + entrySlots(entry), 0)
  if (used > MAX_SYNC_CHANNELS) {
    throw new ToolError(
      "invalid_argument",
      `The sync list would use ${used} of its ${MAX_SYNC_CHANNELS} channel slots (a whole server uses ${WHOLE_SERVER_CHANNELS}, a named channel one). ${MAKE_ROOM}`,
    )
  }
  const excluded = list.servers.find((entry) => entry.id === id)?.exclude?.length ?? 0
  if (excluded > MAX_EXCLUDED_CHANNELS) {
    throw new ToolError(
      "invalid_argument",
      `Server ${id} would exclude ${excluded} channels, and an entry keeps at most ${MAX_EXCLUDED_CHANNELS}.`,
    )
  }
}
