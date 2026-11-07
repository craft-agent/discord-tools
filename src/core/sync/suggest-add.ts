import { idTime } from "../chats/format"
import {
  MAX_SYNC_CHANNELS,
  MAX_SYNC_SERVERS,
  validateSyncList,
  WHOLE_SERVER_CHANNELS,
  type SyncServer,
} from "../discord/sync-list"
import { followedChannelIds } from "./list"
import type { SyncSession } from "./session"
import type { AddSuggestion } from "./suggest-schemas"
import type { SuggestWindow } from "./suggest-window"

/** The least messages of its own the account must have written in a channel for it to be suggested. */
const SUGGEST_MIN_OWN = 1

/** The least messages by anyone a channel needs in the window to be suggested without an own one. */
const SUGGEST_MIN_MESSAGES = 5

/** How much more an own message counts than another's in a channel's score. */
const OWN_MESSAGE_WEIGHT = 3

/** Message types that are what people wrote: plain messages and replies. */
const WRITTEN_MESSAGE_TYPES = [0, 19]

/** Channel types that hold a conversation a sync run can follow: text and announcement. */
const CONVERSATION_CHANNEL_TYPES = [0, 5]

type CandidateRow = {
  id: string
  name: string | null
  server: string
  server_name: string | null
  n: number
  mine: number
  last: string
}

/** The channels with messages in the window, of servers the mirror knows, most worth following first. */
function candidates(session: SyncSession, after: string): CandidateRow[] {
  if (!session.mirror) return []
  return session.mirror
    .prepare(
      `SELECT CAST(c.id AS TEXT) AS id, c.name AS name, CAST(c.server AS TEXT) AS server, s.name AS server_name,
        COUNT(*) AS n, SUM(m.from_me) AS mine, CAST(MAX(m.id) AS TEXT) AS last
      FROM messages m JOIN channels c ON c.id = m.channel JOIN servers s ON s.id = c.server
      WHERE c.server IS NOT NULL AND c.type IN (${CONVERSATION_CHANNEL_TYPES.join(", ")})
        AND m.type IN (${WRITTEN_MESSAGE_TYPES.join(", ")}) AND m.id > ?
      GROUP BY c.id
      HAVING mine >= ${SUGGEST_MIN_OWN} OR n >= ${SUGGEST_MIN_MESSAGES}
      ORDER BY ${OWN_MESSAGE_WEIGHT} * mine + n DESC, MAX(m.id) DESC`,
    )
    .all(BigInt(after)) as CandidateRow[]
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function reasonOf(row: CandidateRow, window: SuggestWindow): string {
  const activity =
    row.mine >= SUGGEST_MIN_OWN ? `You wrote ${plural(row.mine, "message")} there` : `${row.n} messages in the mirror`
  return `${activity} since ${window.sinceDate}, and the sync does not follow it.`
}

/**
 * Whether following `channel` fits `list`, and why not otherwise; the list is
 * `list` with the channel added when it fits.
 */
function tryAdd(list: SyncServer[], server: string, channel: string): { list: SyncServer[]; whyNot?: string } {
  const entry = list.find((candidate) => candidate.id === server)
  if (entry && !entry.channels) {
    return {
      list,
      whyNot:
        "The server is followed whole, so following single channels needs discord_sync_remove on the server first.",
    }
  }
  const named = entry?.channels ?? []
  const next = entry
    ? list.map((candidate) => (candidate === entry ? { ...entry, channels: [...named, channel] } : candidate))
    : [...list, { id: server, channels: [channel] }]
  try {
    validateSyncList({ servers: next })
    return { list: next }
  } catch {
    const whyNot =
      !entry && list.length >= MAX_SYNC_SERVERS
        ? `The sync list already follows ${MAX_SYNC_SERVERS} servers, the most it can.`
        : `The sync list has no room for another channel: ${MAX_SYNC_CHANNELS} channel slots are the most, and a whole server takes ${WHOLE_SERVER_CHANNELS}.`
    return { list, whyNot }
  }
}

/**
 * Channels worth following that the sync list does not follow, best first, at
 * most `limit`; each says whether it fits the list after the ones above it.
 * Channels any entry excludes are never suggested.
 */
export function addSuggestions(
  session: SyncSession,
  list: SyncServer[],
  window: SuggestWindow,
  limit: number,
): AddSuggestion[] {
  const skipped = new Set([
    ...list.flatMap((entry) => followedChannelIds(session, entry)),
    ...list.flatMap((entry) => entry.exclude ?? []),
  ])
  let simulated = list
  return candidates(session, window.after)
    .filter((row) => !skipped.has(row.id))
    .slice(0, limit)
    .map((row): AddSuggestion => {
      const attempt = tryAdd(simulated, row.server, row.id)
      simulated = attempt.list
      return {
        channel: { id: row.id, name: row.name },
        server: { id: row.server, name: row.server_name },
        messages: row.n,
        from_me: row.mine,
        last_message_at: idTime(row.last),
        reason: reasonOf(row, window),
        apply: {
          tool: "discord_sync_add",
          args: { account: session.paths.label, server: row.server, channels: [row.id] },
        },
        fits: attempt.whyNot === undefined,
        ...(attempt.whyNot === undefined ? {} : { why_not: attempt.whyNot }),
      }
    })
}
