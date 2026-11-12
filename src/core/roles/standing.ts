import type { RoleSnapshot, StoredRole } from "../discord/mirror-roles"
import { ADMINISTRATOR, ALL_PERMISSIONS, MANAGE_ROLES } from "./permissions"

/** Where the user stands in a server, as Discord works it out from a role snapshot. */
export type Standing = {
  /** Whether the user owns the server. */
  owner: boolean
  /** The roles the user holds that the snapshot lists, highest first, without @everyone. */
  held: StoredRole[]
  /** The permissions the user has: @everyone's and every held role's joined; all named ones for an owner or an administrator. */
  permissions: bigint
  /** Whether the user may manage roles: `manage_roles`, `administrator` or owning the server. */
  canManageRoles: boolean
  /** The position of the user's highest role, @everyone included. */
  topPosition: number
  /** Whether the user may manage `role`: managing roles, below the highest role (an owner is exempt), not managed by an integration, not @everyone. */
  manageable(role: StoredRole): boolean
}

/**
 * The user's standing in the snapshot's server. `owner` is whether the user
 * owns it, as the mirror's server row last said.
 */
export function standingOf(snapshot: RoleSnapshot, owner: boolean): Standing {
  const own = new Set(snapshot.ownRoles)
  const everyone = snapshot.roles.find((role) => role.id === snapshot.server)
  const held = snapshot.roles.filter((role) => role.id !== snapshot.server && own.has(role.id))
  const joined = [...held, ...(everyone ? [everyone] : [])].reduce((bits, role) => bits | role.permissions, 0n)
  const permissions = owner || (joined & ADMINISTRATOR) !== 0n ? ALL_PERMISSIONS : joined
  const canManageRoles = (permissions & MANAGE_ROLES) !== 0n
  const topPosition = Math.max(0, ...held.map((role) => role.position), everyone?.position ?? 0)
  return {
    owner,
    held,
    permissions,
    canManageRoles,
    topPosition,
    manageable: (role) =>
      canManageRoles && role.id !== snapshot.server && !role.managed && (owner || role.position < topPosition),
  }
}
