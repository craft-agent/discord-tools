import { userLookup } from "../chats/dms"
import { UNTRUSTED_NOTE, displayName } from "../chats/format"
import { ingestUsers } from "../discord/ingest"
import { intOrNull, isRecord, textOrNull } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { checkServer } from "../search/scope"
import { checkUser, serverNameLookup } from "./known"
import { memberFields } from "./member-fields"
import { explainRefusal, readLive } from "./request"
import { byPositionThenId, listedRoles, rolesPath } from "./role-list"
import type { MemberItem, PeopleHandler } from "./schemas"

/** Where Discord keeps a person's membership of a server. */
export const memberPath = (server: string, user: string) => `/guilds/${server}/members/${user}`

/** What the result of `member` tells about whose words the names are and what was stored. */
const MEMBER_NOTE =
  "One person's membership of one server, read from Discord once: their roles are named from the server's role list, highest first, without @everyone (a null name is a role the server no longer lists). Nickname and role names are written by people. Nothing but the user name was stored in the local mirror."

/** A role of a server's role list: its name and where it stands, higher first. */
type Role = { name: string | null; position: number }

/** The roles of Discord's role list by id: an array of objects, else `upstream_error`. An entry without a valid id is left out. */
function rolesById(value: unknown): Map<string, Role> {
  const roles = new Map<string, Role>()
  for (const { id, role } of listedRoles(value)) {
    roles.set(id, { name: textOrNull(role.name), position: intOrNull(role.position) ?? 0 })
  }
  return roles
}

/** The member's roles named from the server's, highest first; the @everyone role (the server's own id) is left out. */
function namedRoles(ids: readonly string[], roles: ReadonlyMap<string, Role>, server: string): MemberItem["roles"] {
  return ids
    .filter((id) => id !== server)
    .map((id) => ({ id, name: roles.get(id)?.name ?? null, position: roles.get(id)?.position ?? null }))
    .sort(byPositionThenId)
    .map(({ id, name }) => ({ id, name }))
}

/**
 * Method `member`: one person's membership of one server and the names of
 * their roles, from the member and the role list, asked one after the other.
 * The person and the server are checked against the mirror before any request;
 * a person who is not a member is `not_found`. Only the user object is stored.
 */
export const readMember: PeopleHandler = async (session, args) => {
  const user = args.user!
  const server = args.server!
  checkUser(session, user)
  checkServer(session, server)
  const member = await readLive(session, "GET", memberPath(server, user)).catch((error: unknown) =>
    explainRefusal(error, { not_found: `User ${user} is not a member of server ${server}.` }),
  )
  const roles = await readLive(session, "GET", rolesPath(server))
  if (!isRecord(member)) invalidResponse()
  const known = rolesById(roles)
  session.store((ctx) => {
    ingestUsers(session.mirror, ctx, isRecord(member.user) ? [member.user] : [])
  })
  const account = userLookup(session.mirror)(user)
  const fields = memberFields(member)
  const item: MemberItem = {
    server,
    server_name: serverNameLookup(session.mirror)(server),
    user,
    name: fields.nick ?? displayName(account) ?? user,
    username: account.username,
    nick: fields.nick,
    joined: fields.joined,
    roles: namedRoles(fields.roles, known, server),
  }
  return { note: `${MEMBER_NOTE} ${UNTRUSTED_NOTE}`, member: item }
}
