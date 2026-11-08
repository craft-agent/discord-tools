import { WHOLE_SERVER_CHANNELS, type SyncServer } from "../discord/sync-list"
import { followedChannelIds, nameOf } from "./list"
import type { SyncSession } from "./session"
import type { RemoveSuggestion } from "./suggest-schemas"
import type { SuggestWindow } from "./suggest-window"

/** The ids among `ids` the mirror holds a channel row for. */
function mirroredAmong(session: SyncSession, ids: string[]): Set<string> {
  if (!session.mirror || ids.length === 0) return new Set()
  const rows = session.mirror
    .prepare(`SELECT CAST(id AS TEXT) AS id FROM channels WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids.map(BigInt)) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

/** The ids of the channels with a message since the window opened, or one the account wrote there. */
function activeChannels(session: SyncSession, after: string): Set<string> {
  if (!session.mirror) return new Set()
  const bound = BigInt(after)
  const rows = session.mirror
    .prepare(
      `SELECT CAST(id AS TEXT) AS id FROM channels WHERE last_message > ?
      UNION SELECT CAST(channel AS TEXT) FROM messages WHERE from_me = 1 AND id > ?`,
    )
    .all(bound, bound) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

function suggestionFor(
  session: SyncSession,
  entry: SyncServer,
  window: SuggestWindow,
  active: Set<string>,
): RemoveSuggestion | undefined {
  const followed = followedChannelIds(session, entry)
  const quiet = followed.filter((id) => !active.has(id))
  const quietNow = `No new message since ${window.sinceDate}`
  const server = { id: entry.id, name: nameOf(session, "servers", entry.id) }
  const account = session.paths.label
  if (!entry.channels) {
    if (followed.length === 0 || quiet.length < followed.length) return undefined
    return {
      server,
      channels: null,
      frees: WHOLE_SERVER_CHANNELS,
      reason: `${quietNow} in any of its ${followed.length} followed channels.`,
      apply: { tool: "discord_sync_remove", args: { account, server: entry.id } },
    }
  }
  if (quiet.length === 0) return undefined
  const unknown = quiet.length - mirroredAmong(session, quiet).size
  return {
    server,
    channels: quiet.map((id) => ({ id, name: nameOf(session, "channels", id) })),
    frees: quiet.length,
    reason: unknown > 0 ? `${quietNow}; the mirror does not know ${unknown} of these channels.` : `${quietNow}.`,
    apply: { tool: "discord_sync_remove", args: { account, server: entry.id, channels: quiet } },
  }
}

/** Entries, or channels of named entries, with no activity in the window, in sync-list order, at most `limit`. */
export function removeSuggestions(
  session: SyncSession,
  list: SyncServer[],
  window: SuggestWindow,
  limit: number,
): RemoveSuggestion[] {
  if (!session.mirror) return []
  const active = activeChannels(session, window.after)
  return list
    .map((entry) => suggestionFor(session, entry, window, active))
    .filter((suggestion): suggestion is RemoveSuggestion => suggestion !== undefined)
    .slice(0, limit)
}
