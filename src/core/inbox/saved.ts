import { UNTRUSTED_NOTE, isoOrNull } from "../chats/format"
import { itemOf, reactionsNote } from "../chats/message-items"
import { ingestMessages } from "../discord/ingest"
import { rowsOfIds } from "../search/items"
import { readSavedList, savedEntries, type SavedEntry } from "../saved/entries"
import { SAVED_LIMIT_DEFAULT } from "./args"
import { placesOf } from "./places"
import type { InboxHandler, SavedItem } from "./schemas"

/** What the result of `saved` tells about whose list it is, what a reminder is and what was stored. */
const SAVED_NOTE =
  "The user's own list of saved messages and reminders, from Discord: reminders first by their time, then saves without one, the newest first. A reminder is Discord's own mark on the save, not a notification this tool sends, and `due` only says its time has passed. The messages were stored in the local mirror (reaction counts are not part of the list); nothing was deleted from it, no chat was marked current and nothing was marked read."

/** The id of a message as a number, to compare ids of any length. */
const idOf = (entry: SavedEntry) => BigInt(entry.message)

/** Orders saves with a reminder first, by its time, then those without one, the newest saved first; the message id settles a tie. */
function bySavedOrder(a: SavedEntry, b: SavedEntry): number {
  if (a.remindAt !== null && b.remindAt !== null && a.remindAt !== b.remindAt) return a.remindAt - b.remindAt
  if (a.remindAt !== null && b.remindAt === null) return -1
  if (a.remindAt === null && b.remindAt !== null) return 1
  if (a.savedAt !== b.savedAt) return b.savedAt - a.savedAt
  const [x, y] = [idOf(a), idOf(b)]
  return x === y ? 0 : x > y ? -1 : 1
}

/**
 * Method `saved`: the user's saved messages and reminders, from the one list
 * Discord gives. The messages it sent are stored in the mirror as `mentions`
 * stores theirs: nothing is deleted, stored reactions are kept and no chat is
 * marked current. A save whose message Discord did not send has `message: null`.
 */
export const readSaved: InboxHandler = async (session, args) => {
  const limit = args.limit ?? SAVED_LIMIT_DEFAULT
  const entries = savedEntries(await readSavedList(session)).sort(bySavedOrder)
  session.store((ctx) => {
    const found = entries.flatMap(({ payload }) => payload ?? [])
    ingestMessages(session.mirror, ctx, found, { reactions: false })
  })
  const shown = entries.slice(0, limit)
  const rows = new Map(
    rowsOfIds(
      session,
      shown.map(({ message }) => message),
    ).map((row) => [row.id, row]),
  )
  const places = placesOf(session.mirror)
  const saved = shown.map((entry): SavedItem => {
    const found = rows.get(entry.message)
    const row = found?.channel === entry.channel ? found : undefined
    const server = row?.server ?? entry.guild
    return {
      channel: entry.channel,
      chat: places.chat(entry.channel),
      server,
      server_name: places.server(server),
      message_id: entry.message,
      saved_at: new Date(entry.savedAt).toISOString(),
      remind_at: isoOrNull(entry.remindAt),
      due: entry.remindAt !== null && entry.remindAt <= session.now(),
      message: row ? itemOf(row, session.me) : null,
    }
  })
  return {
    source: "discord",
    note: `${SAVED_NOTE} ${UNTRUSTED_NOTE}`,
    saved,
    total: entries.length,
    more: entries.length > shown.length,
    ...reactionsNote(saved.flatMap(({ message }) => message ?? [])),
  }
}
