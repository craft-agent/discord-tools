import { liveHeader, roleItem } from "./items"
import { readLiveRoles } from "./live"
import type { RoleHandler } from "./schemas"

/**
 * Method `list`: every role of a server, highest first, with where the user
 * stands among them; the read is stored as the server's role snapshot.
 */
export const readList: RoleHandler = async (session, args) => {
  const live = await readLiveRoles(session, args.server)
  return { ...liveHeader(session, live), roles: live.snapshot.roles.map((role) => roleItem(live, role)) }
}
