import type { ChatSession } from "../chats/session"
import { idTexts, isRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { isToolError } from "../errors"
import { memberFields } from "../people/member-fields"
import { memberPath } from "../people/member"
import { readLive } from "../people/request"
import { lookOnce } from "../threads/read-back"
import { memberIdsPath } from "./members"
import { ROLE_MEMBERS_CAP } from "./schemas"

/**
 * What the one look after an uncertain role write saw: for one user whether
 * they hold the role; for several the asked ids Discord lists among the role's
 * holders (`capped` when the list is as long as it goes, so an id missing from
 * it is unknown); or that it could not look (`failed`) or was cancelled first
 * (`skipped`).
 */
export type RoleReadBack = { has_role: boolean } | { holders: string[]; capped: boolean } | "failed" | "skipped"

/** The page of the web client a role write and its read-back come from: the server's. */
export const serverReferer = (server: string) => `/channels/${server}`

/** Whether the user holds the role: Discord has no member (404) for a user who left the server, who holds nothing there. */
async function holdsRole(session: ChatSession, server: string, role: string, user: string): Promise<RoleReadBack> {
  try {
    const member = await readLive(session, "GET", memberPath(server, user), { referer: serverReferer(server) })
    if (!isRecord(member)) invalidResponse()
    return { has_role: memberFields(member).roles.includes(role) }
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return { has_role: false }
    throw error
  }
}

/** The asked ids among the ids Discord lists for the role. */
async function holdersAmong(session: ChatSession, server: string, role: string, users: readonly string[]) {
  const ids = await readLive(session, "GET", memberIdsPath(server, role), { referer: serverReferer(server) })
  if (!Array.isArray(ids)) invalidResponse()
  const listed = new Set(idTexts(ids))
  return { holders: users.filter((user) => listed.has(user)), capped: ids.length >= ROLE_MEMBERS_CAP }
}

/**
 * The one look after an uncertain role write: the member's own record for one
 * user, the role's member ids for several. Nothing is stored.
 */
export function readBackRole(
  session: ChatSession,
  server: string,
  role: string,
  users: readonly string[],
): Promise<RoleReadBack> {
  return lookOnce(session, () =>
    users.length === 1 ? holdsRole(session, server, role, users[0]!) : holdersAmong(session, server, role, users),
  )
}
