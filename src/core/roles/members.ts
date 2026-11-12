import { UNTRUSTED_NOTE, displayName } from "../chats/format"
import { userLookup } from "../chats/dms"
import { idTexts } from "../discord/ingest-values"
import { readRoleSnapshot } from "../discord/mirror-roles"
import { invalidResponse } from "../discord/sync-page"
import { ToolError } from "../errors"
import { readLive } from "../people/request"
import { rolesPath } from "../people/role-list"
import { checkServer } from "../search/scope"
import { ROLE_MEMBERS_CAP, type RoleHandler } from "./schemas"

/** Where Discord lists the ids of the members who hold a role. */
export const memberIdsPath = (server: string, role: string) => `${rolesPath(server)}/${role}/member-ids`

/** What the result of `members` tells about its length, the names and what was stored. */
const MEMBERS_NOTE = `The ids Discord lists for one role, ${ROLE_MEMBERS_CAP} at most (\`capped\` when it reached that), each with the name the local mirror holds, null for a user it does not know. Nothing was stored. ${UNTRUSTED_NOTE}`

/**
 * Method `members`: the member ids of a role in the stored snapshot, from
 * Discord, named from the mirror's users. The server is checked against the
 * mirror, and the role against its snapshot, before any request; a server
 * without a snapshot, or a snapshot without the role, is `not_found`, saying to
 * call `list` first. Nothing is stored.
 */
export const readMembers: RoleHandler = async (session, args) => {
  const { server } = args
  const role = args.role!
  checkServer(session, server)
  const held = readRoleSnapshot(session.mirror, server)?.roles.find(({ id }) => id === role)
  if (held === undefined) {
    throw new ToolError(
      "not_found",
      `No stored snapshot of server ${server} holds role ${role}: call discord_role_read with method list first.`,
    )
  }
  const ids = await readLive(session, "GET", memberIdsPath(server, role))
  if (!Array.isArray(ids)) invalidResponse()
  const user = userLookup(session.mirror)
  const members = idTexts(ids).map((id) => ({ id, name: displayName(user(id)) }))
  return {
    note: MEMBERS_NOTE,
    server,
    role: { id: held.id, name: held.name },
    members,
    count: members.length,
    capped: members.length >= ROLE_MEMBERS_CAP,
  }
}
