import { userLookup } from "../chats/dms"
import { UNTRUSTED_NOTE, displayName } from "../chats/format"
import { ingestUsers } from "../discord/ingest"
import { idText, isRecord, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { checkServer } from "../search/scope"
import { countOrNull } from "./count"
import { memberFields } from "./member-fields"
import { explainRefusal, readLive } from "./request"
import { MEMBERS_LIMIT_DEFAULT, type MemberHit, type PeopleHandler } from "./schemas"

/** Where Discord searches a server's members. */
export const membersSearchPath = (server: string) => `/guilds/${server}/members-search`

/** What Discord's refusal to search a server's members means, said ahead of Discord's own message. */
const MEMBERS_REFUSED =
  "Searching a server's members needs the Manage Server permission in that server: take user ids from messages, mentions or the friend list instead."

/** What the result of `members` tells about its reach, whose words the names are and what was stored. */
const MEMBERS_NOTE =
  "Members of the server whose name Discord's own search matched, in its order, read once: `total` is Discord's count of matches, and `roles` are ids (method member names them). Names and nicknames are written by people. Nothing but user names was stored in the local mirror."

/** A found member: the member object (Discord wraps it with how they joined) and its user, which has a valid id. */
type Found = { member: JsonRecord; user: JsonRecord }

/** The members of Discord's answer: an object with a list of them, else `upstream_error`. An entry without a member object with a user is left out. */
function foundIn(value: unknown): { found: Found[]; total: number | null } {
  if (!isRecord(value) || !Array.isArray(value.members)) invalidResponse()
  const found = value.members.flatMap((entry): Found[] => {
    const member = isRecord(entry) && isRecord(entry.member) ? entry.member : entry
    return isRecord(member) && isRecord(member.user) && idText(member.user.id) !== null
      ? [{ member, user: member.user }]
      : []
  })
  return { found, total: countOrNull(value.total_result_count) }
}

/**
 * Method `members`: a server's members whose name matches `query`, by
 * Discord's own search, which needs Manage Server. The server is checked
 * against the mirror before the request, a POST that changes nothing and is
 * sent as a read. Only the user objects are stored.
 */
export const readMembers: PeopleHandler = async (session, args) => {
  const server = args.server!
  checkServer(session, server)
  const value = await readLive(session, "POST", membersSearchPath(server), {
    referer: `/channels/${server}`,
    body: { limit: args.limit ?? MEMBERS_LIMIT_DEFAULT, or_query: { usernames: { or_query: [args.query!] } } },
  }).catch((error: unknown) => explainRefusal(error, { forbidden: MEMBERS_REFUSED }))
  const { found, total } = foundIn(value)
  session.store((ctx) => {
    ingestUsers(
      session.mirror,
      ctx,
      found.map(({ user }) => user),
    )
  })
  const lookup = userLookup(session.mirror)
  const members = found.map(({ member, user }): MemberHit => {
    const id = user.id as string
    const account = lookup(id)
    const fields = memberFields(member)
    return { id, name: fields.nick ?? displayName(account) ?? id, username: account.username, ...fields }
  })
  return { note: `${MEMBERS_NOTE} ${UNTRUSTED_NOTE}`, members, count: members.length, total }
}
