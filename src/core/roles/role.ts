import { ToolError } from "../errors"
import { liveHeader, roleDetail } from "./items"
import { readLiveRoles } from "./live"
import type { RoleHandler } from "./schemas"

/**
 * Method `role`: one role of a server with all its permissions, read the way
 * `list` reads and stored the same way, so it refreshes the snapshot. A role the
 * server does not list is `not_found`.
 */
export const readRole: RoleHandler = async (session, args) => {
  const live = await readLiveRoles(session, args.server)
  const role = live.snapshot.roles.find(({ id }) => id === args.role)
  if (role === undefined) {
    throw new ToolError("not_found", `Server ${args.server} has no role ${args.role}: list its roles with method list.`)
  }
  return { ...liveHeader(session, live), role: roleDetail(live, role) }
}
