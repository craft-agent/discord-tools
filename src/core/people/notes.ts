import { userLookup } from "../chats/dms"
import { UNTRUSTED_NOTE, displayName } from "../chats/format"
import type { ChatSession } from "../chats/session"
import { isToolError } from "../errors"
import { fieldOf, isRecord, textOrNull } from "../discord/ingest-values"
import { isSnowflake } from "../discord/snowflake"
import { invalidResponse } from "../discord/sync-page"
import { checkUser } from "./known"
import { byNameThenId } from "./order"
import type { NoteItem, PeopleHandler } from "./schemas"

/** Where Discord lists the account's notes on other users, and keeps the one on a user at `<path>/<user>`. */
export const NOTES_PATH = "/users/@me/notes"

/** What the result of `notes` tells about whose words they are and what to do with them. */
const NOTES_NOTE =
  "The user's own private notes about other users, from Discord: never send or share them unless the user asks. User names come from the local mirror (null when it does not know the user); nothing was stored."

/** A note and the user it is about, with the names the mirror holds for the user. */
type NoteRow = Omit<NoteItem, "user"> & { id: string }

/** Reads `path` for the session, with its abort signal. */
const readPath = (session: ChatSession, path: string) =>
  session.client().read("GET", path, session.signal ? { signal: session.signal } : {})

/** The row of a note on `id`, named from the mirror. */
function rowOf(lookup: ReturnType<typeof userLookup>, id: string, note: string | null): NoteRow {
  const user = lookup(id)
  return { id, name: displayName(user), username: user.username, note }
}

/** Every note: Discord's object of notes by user id, else `upstream_error`. An entry without a user id or a text is left out. */
async function allNotes(session: ChatSession): Promise<NoteRow[]> {
  const value = await readPath(session, NOTES_PATH)
  if (!isRecord(value)) invalidResponse()
  const lookup = userLookup(session.mirror)
  return Object.entries(value)
    .flatMap(([id, note]) => {
      const text = textOrNull(note)
      return isSnowflake(id) && text !== null ? [rowOf(lookup, id, text)] : []
    })
    .sort(byNameThenId)
}

/** The note on one user, which the mirror must know; a user with none (Discord answers `not_found`) has `note` null. */
async function oneNote(session: ChatSession, user: string): Promise<NoteRow> {
  checkUser(session, user)
  const lookup = userLookup(session.mirror)
  try {
    const value = await readPath(session, `${NOTES_PATH}/${user}`)
    if (!isRecord(value)) invalidResponse()
    return rowOf(lookup, user, textOrNull(fieldOf(value, "note")))
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return rowOf(lookup, user, null)
    throw error
  }
}

/** Method `notes`: the user's notes on other users, all of them or the one on `user`; nothing is stored in the mirror. */
export const readNotes: PeopleHandler = async (session, args) => {
  const rows = args.user === undefined ? await allNotes(session) : [await oneNote(session, args.user)]
  const notes = rows.map(({ id, name, username, note }): NoteItem => ({ user: id, name, username, note }))
  return {
    note: `${NOTES_NOTE} ${UNTRUSTED_NOTE}`,
    notes,
    count: notes.filter(({ note }) => note !== null).length,
  }
}
