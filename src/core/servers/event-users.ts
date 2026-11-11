import { UNTRUSTED_NOTE, displayName } from "../chats/format"
import { ingestUsers } from "../discord/ingest"
import { fieldOf, idText, isRecord, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { explainRefusal, readLive } from "../people/request"
import { checkServer } from "../search/scope"
import { entriesOf } from "./entries"
import { eventsPath } from "./events"
import { INTERESTED_LIMIT_DEFAULT, type InterestedItem, type ServerHandler } from "./schemas"

/** Where Discord lists the users interested in one scheduled event. */
export const eventUsersPath = (server: string, event: string) => `${eventsPath(server)}/${event}/users`

/** What a refusal to list an event's users means, said ahead of Discord's own message. */
const EVENT_REFUSED = "No such event in that server (finished events are not listed)."

/** What the result of `events` with `event` tells about who is listed, how to page, whose words the names are and what was stored. */
const EVENT_USERS_NOTE =
  "The users who said they are interested in one scheduled event, as Discord lists them, read once: `limit` at most, and `next_after` is the `after` of the next page (null when this page was the last). Names and nicknames are written by people. Only user names were stored in the local mirror."

/** An interested user: the user object, which has a valid id, and the member object when Discord sent one. */
type Interested = { user: JsonRecord; id: string; member: JsonRecord | undefined }

/**
 * The users of Discord's answer: an array of entries, or an object with one
 * under `users`, else `upstream_error`. An entry without a user object that has
 * a valid id is left out.
 */
function interestedIn(value: unknown): { entries: number; interested: Interested[] } {
  const entries = entriesOf(isRecord(value) ? value.users : value)
  const interested = entries.flatMap((entry): Interested[] => {
    const { user } = entry
    const id = idText(fieldOf(user, "id"))
    if (!isRecord(user) || id === null) return []
    return [{ user, id, member: isRecord(entry.member) ? entry.member : undefined }]
  })
  return { entries: entries.length, interested }
}

/**
 * Method `events` with `event`: the users interested in one scheduled event,
 * one page of Discord's list in its order, from `after` when given. The server
 * is checked against the mirror before the request; only the user objects are
 * stored.
 */
export const readEventUsers: ServerHandler = async (session, args) => {
  const server = args.server
  const event = args.event!
  checkServer(session, server)
  const limit = args.limit ?? INTERESTED_LIMIT_DEFAULT
  const value = await readLive(session, "GET", eventUsersPath(server, event), {
    query: { limit, after: args.after, with_member: true },
  }).catch((error: unknown) => explainRefusal(error, { not_found: EVENT_REFUSED }))
  const { entries, interested } = interestedIn(value)
  session.store((ctx) => {
    ingestUsers(
      session.mirror,
      ctx,
      interested.map(({ user }) => user),
    )
  })
  const users = interested.map(({ user, id, member }): InterestedItem => {
    const username = textOrNull(user.username)
    return {
      id,
      name: textOrNull(member?.nick) ?? displayName({ username, global_name: textOrNull(user.global_name) }) ?? id,
      username,
      nick: textOrNull(member?.nick),
    }
  })
  return {
    note: `${EVENT_USERS_NOTE} ${UNTRUSTED_NOTE}`,
    event,
    interested_users: users,
    count: users.length,
    next_after: entries === limit ? (users.at(-1)?.id ?? null) : null,
  }
}
