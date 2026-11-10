import { clip, idTime, isoOrNull, TEXT_PREVIEW_LENGTH, UNTRUSTED_NOTE } from "../chats/format"
import { DM_TYPE, GROUP_DM_TYPE } from "../chats/dms"
import { itemOf, WRITTEN_TYPES } from "../chats/message-items"
import { getMeta } from "../discord/mirror"
import { isChannelCurrent } from "../discord/mirror-cursors"
import { snowflakeAt } from "../discord/snowflake"
import { LAST_SYNC_AT_META } from "../discord/sync-status"
import { rowsOfIds } from "../search/items"
import { someElement } from "../search/mirror"
import { checkServer } from "../search/scope"
import { sinceId, WAITING_LIMIT_DEFAULT } from "./args"
import { placesOf } from "./places"
import { type InboxHandler, WAITING_REASONS, type WaitingChat, type WaitingReason } from "./schemas"

/** How far back `waiting` looks when `since` is left out: 14 days, in milliseconds. */
const WAITING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** What the result of `waiting` says about what it counts, where it comes from and what it cannot know. */
const WAITING_NOTE =
  "These chats wait for the user's answer: `waiting` means not answered, and says nothing about whether the user has read a message, which may have been read on another device; nothing here was marked read. A message counts when it is from someone else, an ordinary message or a reply, and newer than the user's last message in that chat; in a server it must also reply to a message of the user's or mention the user by id (@everyone and roles do not count). This was read from the local mirror alone, so a chat whose `current` is false may hold newer messages, or an answer the user gave elsewhere, that the mirror does not have yet: read it with `discord_chat_read`."

/** A chat with messages that wait, as the mirror's query groups them. */
type WaitingGroup = {
  channel: string
  server: string | null
  waiting: number
  oldest: string
  latest: string
  private: number
  reply: number
  mention: number
}

/**
 * The query that groups the messages waiting after `since` by chat, the chat
 * with the newest first. `?` stand for `since` (as a bound on the user's own
 * messages), the user's id, `since` again and, with `withServer`, the server.
 * The user's last message of a chat is looked for only after `since`, which is
 * all that can matter, so the query never reads a chat's older history.
 */
function groupsQuery(withServer: boolean): string {
  const mention = someElement("m.mentions", "e.value = ?")
  return `
    WITH mine AS (
      SELECT channel, MAX(id) AS last FROM messages WHERE from_me = 1 AND id > ? GROUP BY channel
    ), candidates AS (
      SELECT m.id AS id, m.channel AS channel, COALESCE(m.server, c.server) AS server,
             COALESCE(c.type IN (${DM_TYPE}, ${GROUP_DM_TYPE}), 0) AS private,
             CASE WHEN m.ref_kind = 'reply'
                  THEN EXISTS (SELECT 1 FROM messages r WHERE r.id = m.ref_message AND r.from_me = 1)
                  ELSE 0 END AS reply,
             ${mention} AS mention
      FROM messages m
      LEFT JOIN channels c ON c.id = m.channel
      LEFT JOIN mine ON mine.channel = m.channel
      WHERE m.from_me = 0 AND m.type IN (${WRITTEN_TYPES.join(", ")}) AND m.id > ? AND m.id > COALESCE(mine.last, 0)
        ${withServer ? "AND COALESCE(m.server, c.server) = ?" : ""}
    )
    SELECT CAST(channel AS TEXT) AS channel, CAST(MAX(server) AS TEXT) AS server, COUNT(*) AS waiting,
           CAST(MIN(id) AS TEXT) AS oldest, CAST(MAX(id) AS TEXT) AS latest,
           MAX(private) AS private, MAX(reply) AS reply, MAX(mention) AS mention
    FROM candidates
    WHERE private OR reply OR mention
    GROUP BY channel
    ORDER BY MAX(id) DESC`
}

/** Why a chat waits: a DM or group DM for that alone, else a reply, a mention or both. */
function reasonsOf(group: WaitingGroup): WaitingReason[] {
  const holds: Partial<Record<WaitingReason, boolean>> =
    group.private === 1 ? { dm: true } : { reply: group.reply === 1, mention: group.mention === 1 }
  return WAITING_REASONS.filter((reason) => holds[reason])
}

/** When the last complete sync run finished, as an ISO 8601 UTC time; `null` when none did. */
function lastSyncAt(meta: Record<string, string>): string | null {
  const at = Number(meta[LAST_SYNC_AT_META])
  return meta[LAST_SYNC_AT_META] === undefined || !Number.isFinite(at) ? null : isoOrNull(at)
}

/**
 * Method `waiting`: the chats that wait for the user's answer, the one with the
 * newest message first, from the mirror alone; no request is made. A message
 * waits when it is from someone else, an ordinary message or a reply, newer
 * than `since` and than the user's last message in its chat, and either in a
 * DM or group DM, or, in a server, a reply to one of the user's messages or a
 * mention of the user's id. It is "not answered", never "unread".
 */
export const readWaiting: InboxHandler = async (session, args) => {
  const limit = args.limit ?? WAITING_LIMIT_DEFAULT
  if (args.server !== undefined) checkServer(session, args.server)
  const since = args.since === undefined ? snowflakeAt(session.now() - WAITING_WINDOW_MS) : sinceId(args.since)
  const params = [BigInt(since), session.me, BigInt(since), ...(args.server === undefined ? [] : [BigInt(args.server)])]
  const groups = session.mirror.prepare(groupsQuery(args.server !== undefined)).all(...params) as WaitingGroup[]

  const shown = groups.slice(0, limit)
  const latest = new Map(
    rowsOfIds(
      session,
      shown.map((group) => group.latest),
    ).map((row) => [row.id, row]),
  )
  const places = placesOf(session.mirror)
  const chats = shown.flatMap((group): WaitingChat[] => {
    const row = latest.get(group.latest)
    if (!row) return []
    const message = itemOf(row, session.me)
    return [
      {
        chat: {
          id: group.channel,
          name: places.chat(group.channel),
          kind: places.kind(group.channel),
          server: group.server,
          server_name: places.server(group.server),
        },
        why: reasonsOf(group),
        waiting: group.waiting,
        since: idTime(group.oldest),
        latest: {
          id: message.id,
          at: message.at,
          author_id: message.author_id,
          author: message.author,
          text: clip(message.text, TEXT_PREVIEW_LENGTH),
        },
        current: isChannelCurrent(session.mirror, group.channel, session.now()),
      },
    ]
  })
  const syncedAt = lastSyncAt(getMeta(session.mirror))
  const synced =
    syncedAt === null ? "No complete sync run has finished yet." : `The last complete sync run finished at ${syncedAt}.`
  return {
    source: "mirror",
    note: `${WAITING_NOTE} ${synced} ${UNTRUSTED_NOTE}`,
    chats,
    total: groups.length,
    more: groups.length > limit,
    window_start: idTime(since),
    last_sync_at: syncedAt,
  }
}
