import { UNTRUSTED_NOTE } from "../chats/format"
import type { ChatSession } from "../chats/session"
import { ROLE_SNAPSHOT_MAX_AGE_MS, type StoredRole } from "../discord/mirror-roles"
import { countOrNull } from "../people/count"
import { serverNameLookup } from "../people/known"
import { colorOrNull } from "../servers/roles"
import type { LiveRoles } from "./live"
import { permissionNames, strongNames } from "./permissions"
import type { RoleDetail, RoleItem, RolePayload, YouItem } from "./schemas"

/** What `list` and `role` tell about the counts, the stored snapshot and whose words the names are. */
export const SNAPSHOT_NOTE = `Read from Discord once and stored as this server's role snapshot, which role writes check against and refuse once it is older than ${ROLE_SNAPSHOT_MAX_AGE_MS / 60_000} minutes (read again then); \`read_at\` is when it was read. \`members\` is how many members hold a role as Discord counts them, null when it gives no count (\`counts_missing\` when it refused the counts). Role names are written by the server's admins. ${UNTRUSTED_NOTE}`

/** A role as `list` shows it. */
export function roleItem(live: LiveRoles, role: StoredRole): RoleItem {
  const object = live.objects.get(role.id)
  return {
    id: role.id,
    name: role.name,
    position: role.position,
    color: colorOrNull(object?.color),
    members: live.counts === null ? null : countOrNull(live.counts[role.id]),
    hoist: object?.hoist === true,
    mentionable: object?.mentionable === true,
    managed: role.managed,
    everyone: role.id === live.snapshot.server,
    strong: strongNames(role.permissions),
    manageable: live.standing.manageable(role),
  }
}

/** A role as `role` shows it: the list's fields and every permission by name. */
export function roleDetail(live: LiveRoles, role: StoredRole): RoleDetail {
  return { ...roleItem(live, role), permissions: permissionNames(role.permissions) }
}

/** Where the user stands, from the live read's standing. */
export function youItem({ standing }: LiveRoles): YouItem {
  return {
    owner: standing.owner,
    roles: standing.held.map(({ id, name }) => ({ id, name })),
    permissions: permissionNames(standing.permissions),
    manage_roles: standing.canManageRoles,
    highest_position: standing.topPosition,
  }
}

/** The parts of a `list` or `role` result they share. */
export function liveHeader(session: ChatSession, live: LiveRoles): Omit<RolePayload, "roles" | "role"> {
  const { server, readAt } = live.snapshot
  return {
    note: SNAPSHOT_NOTE,
    server,
    server_name: serverNameLookup(session.mirror)(server),
    read_at: new Date(readAt).toISOString(),
    you: youItem(live),
    counts_missing: live.counts === null,
    ...(live.steps.any ? { errors: live.steps.errors } : {}),
  }
}
