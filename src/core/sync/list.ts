import { THREAD_TYPES } from "../chats/channels"
import { idOrNull, type JsonRecord } from "../discord/ingest-values"
import { isChannelCurrent } from "../discord/mirror-cursors"
import {
  MAX_SYNC_CHANNELS,
  MAX_SYNC_SERVERS,
  readSyncList,
  WHOLE_SERVER_CHANNELS,
  type SyncServer,
} from "../discord/sync-list"
import { pickServerChannels } from "../discord/sync-selection"
import type { FollowedServer } from "./schemas"
import type { SyncHandler, SyncSession } from "./session"

type NameRow = { name: string | null }

/** The name the mirror holds for a server or a channel; null when unknown or when there is no mirror. */
export function nameOf(session: SyncSession, table: "servers" | "channels", id: string): string | null {
  const key = idOrNull(id)
  if (!session.mirror || key === null) return null
  const row = session.mirror.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(key) as NameRow | undefined
  return row?.name ?? null
}

/**
 * The channel rows the mirror holds for a server, shaped as a channel list for
 * `pickServerChannels`. Threads are left out: the mirror keeps those a thread
 * read stored, but a server's channel list, which a sync run picks from,
 * carries none.
 */
function mirroredChannels(session: SyncSession, server: string): JsonRecord[] {
  const key = idOrNull(server)
  if (!session.mirror || key === null) return []
  return session.mirror
    .prepare(
      `SELECT CAST(id AS TEXT) AS id, type, CAST(last_message AS TEXT) AS last_message_id FROM channels WHERE server = ? AND type NOT IN (${THREAD_TYPES.join(", ")})`,
    )
    .all(key) as JsonRecord[]
}

/** The ids of the channels the entry follows: the named ones not excluded, or what a sync run would pick from the mirrored rows. */
export function followedChannelIds(session: SyncSession, entry: SyncServer): string[] {
  if (entry.channels) return entry.channels.filter((id) => !entry.exclude?.includes(id))
  return pickServerChannels(mirroredChannels(session, entry.id), entry).map((row) => row.id as string)
}

function followedServer(session: SyncSession, entry: SyncServer): FollowedServer {
  const now = session.now()
  return {
    id: entry.id,
    name: nameOf(session, "servers", entry.id),
    follows: entry.channels ? "channels" : "server",
    channels: followedChannelIds(session, entry).map((id) => ({
      id,
      name: nameOf(session, "channels", id),
      current: session.mirror ? isChannelCurrent(session.mirror, id, now) : false,
    })),
    exclude: (entry.exclude ?? []).map((id) => ({ id, name: nameOf(session, "channels", id) })),
    slots: entry.channels?.length ?? WHOLE_SERVER_CHANNELS,
  }
}

/** Method `list`: the servers and channels the sync service follows, with the limits they count against. */
export const readList: SyncHandler = async (session) => {
  const servers = (await readSyncList(session.paths)).servers.map((entry) => followedServer(session, entry))
  return {
    dms: "always",
    servers,
    limits: {
      servers: { used: servers.length, max: MAX_SYNC_SERVERS },
      channels: { used: servers.reduce((sum, server) => sum + server.slots, 0), max: MAX_SYNC_CHANNELS },
      whole_server_channels: WHOLE_SERVER_CHANNELS,
    },
  }
}
