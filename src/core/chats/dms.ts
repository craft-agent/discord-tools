import { ingestDmList } from "../discord/ingest"
import { idText, listOf } from "../discord/ingest-values"
import type { Mirror } from "../discord/mirror"
import { CURRENT_MS } from "../discord/mirror-cursors"
import { DM_LIST_AT_META } from "../discord/mirror-meta"
import { channelRecords } from "../discord/sync-page"
import { DMS_LIMIT_DEFAULT } from "./args"
import { clip, displayName, idTime, isoOrNull, TEXT_PREVIEW_LENGTH } from "./format"
import { freshStamp, listStamp } from "./lists"
import type { DmItem } from "./schemas"
import type { ChatHandler } from "./session"

/** The channel types of a DM and of a group DM. */
const DM_TYPE = 1
const GROUP_DM_TYPE = 3

type DmRow = { id: string; type: number; name: string | null; recipients: string | null; last_message: string | null }
type UserRow = { username: string | null; global_name: string | null }
type LastRow = UserRow & { id: string; from_me: number; author: string | null; content: string; created_at: number }

/** The recipient ids a stored `recipients` column holds. */
function recipientIds(json: string | null): string[] {
  if (json === null) return []
  try {
    return listOf(JSON.parse(json) as unknown).flatMap((id) => idText(id) ?? [])
  } catch {
    return []
  }
}

/** Looks users up by id in the mirror. */
function userLookup(mirror: Mirror): (id: string) => UserRow {
  const statement = mirror.prepare("SELECT username, global_name FROM users WHERE id = ?")
  return (id) => (statement.get(BigInt(id)) as UserRow | undefined) ?? { username: null, global_name: null }
}

/** The newest mirrored message of each channel, with its author's names. */
function lastMessage(mirror: Mirror): (channel: string) => LastRow | undefined {
  const statement = mirror.prepare(
    `SELECT CAST(m.id AS TEXT) AS id, m.from_me, CAST(m.author AS TEXT) AS author, m.content, m.created_at,
            u.username, u.global_name
     FROM messages m LEFT JOIN users u ON u.id = m.author
     WHERE m.channel = ? ORDER BY m.id DESC LIMIT 1`,
  )
  return (channel) => statement.get(BigInt(channel)) as LastRow | undefined
}

/** Method `dms`: the DMs and group DMs the latest full list held, newest first, from the mirror while it is current, else from Discord. */
export const readDms: ChatHandler = async (session, args) => {
  const fresh = freshStamp(session, DM_LIST_AT_META, CURRENT_MS)
  if (fresh === null) {
    const dms = channelRecords(
      await session.client().read("GET", "/users/@me/channels", {
        ...(session.signal ? { signal: session.signal } : {}),
      }),
    ).filter((row) => row.type === DM_TYPE || row.type === GROUP_DM_TYPE)
    session.store((ctx) => ingestDmList(session.mirror, ctx, dms))
  }
  const since = fresh ?? listStamp(session, DM_LIST_AT_META) ?? 0
  const rows = session.mirror
    .prepare(
      `SELECT CAST(id AS TEXT) AS id, type, name, recipients, CAST(last_message AS TEXT) AS last_message
       FROM channels WHERE type IN (?, ?) AND updated >= ?
       ORDER BY COALESCE(last_message, 0) DESC, id DESC`,
    )
    .all(DM_TYPE, GROUP_DM_TYPE, since) as DmRow[]

  const user = userLookup(session.mirror)
  const query = args.query?.toLowerCase()
  const matching = rows
    .map((row) => ({ row, recipients: recipientIds(row.recipients).map((id) => ({ id, ...user(id) })) }))
    .filter(({ row, recipients }) => {
      if (query === undefined) return true
      const names = [row.name, ...recipients.flatMap((person) => [person.username, person.global_name])]
      return names.some((name) => name?.toLowerCase().includes(query))
    })

  const offset = args.offset ?? 0
  const limit = args.limit ?? DMS_LIMIT_DEFAULT
  const last = lastMessage(session.mirror)
  const dms: DmItem[] = matching.slice(offset, offset + limit).map(({ row, recipients }) => {
    const message = last(row.id)
    return {
      id: row.id,
      kind: row.type === GROUP_DM_TYPE ? "group_dm" : "dm",
      name: row.type === GROUP_DM_TYPE ? row.name : null,
      recipients: recipients.map((person) => ({ id: person.id, name: displayName(person) })),
      last_message_at: row.last_message === null ? null : idTime(row.last_message),
      last: message
        ? {
            id: message.id,
            from_me: message.from_me === 1,
            author_id: message.author,
            author: displayName(message),
            at: isoOrNull(message.created_at) ?? idTime(message.id),
            text: clip(message.content, TEXT_PREVIEW_LENGTH),
          }
        : null,
    }
  })
  return {
    source: fresh === null ? "live" : "mirror",
    dms,
    next_offset: matching.length > offset + limit ? offset + limit : null,
  }
}
