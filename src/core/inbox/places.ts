import { THREAD_TYPES } from "../chats/channels"
import { type ChannelRow, chatName } from "../chats/describe"
import { DM_TYPE, GROUP_DM_TYPE } from "../chats/dms"
import { channelKind } from "../chats/format"
import type { Mirror } from "../discord/mirror"
import type { WaitingChatKind } from "./schemas"

type NameRow = { name: string | null }

/** Where a chat is, as the mirror knows it. */
export type Places = {
  /** The chat as people see it (see `chatName`); its id when the mirror does not know it. */
  chat(id: string): string
  /** The kind of the chat; `other` when the mirror does not know it. */
  kind(id: string): WaitingChatKind
  /** The server's name; `null` for no server, or one the mirror holds no name for. */
  server(id: string | null): string | null
}

/** The kind of a channel type. */
function kindOfType(type: number): WaitingChatKind {
  if (type === DM_TYPE) return "dm"
  if (type === GROUP_DM_TYPE) return "group_dm"
  return THREAD_TYPES.includes(type) ? "thread" : channelKind(type)
}

/** Looks chats and servers up in the mirror, each once however often it is asked for. */
export function placesOf(mirror: Mirror): Places {
  const channelStatement = mirror.prepare(
    `SELECT CAST(server AS TEXT) AS server, type, name, CAST(parent AS TEXT) AS parent, recipients
     FROM channels WHERE id = ?`,
  )
  const serverStatement = mirror.prepare("SELECT name FROM servers WHERE id = ?")
  const channels = new Map<string, ChannelRow | undefined>()
  const servers = new Map<string, string | null>()
  const channel = (id: string) => {
    if (!channels.has(id)) channels.set(id, channelStatement.get(BigInt(id)) as ChannelRow | undefined)
    return channels.get(id)
  }
  return {
    chat(id) {
      const row = channel(id)
      return row ? chatName(mirror, id, row) : id
    },
    kind(id) {
      const row = channel(id)
      return row ? kindOfType(row.type) : "other"
    },
    server(id) {
      if (id === null) return null
      if (!servers.has(id)) servers.set(id, (serverStatement.get(BigInt(id)) as NameRow | undefined)?.name || null)
      return servers.get(id) ?? null
    },
  }
}
