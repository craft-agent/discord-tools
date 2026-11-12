import type { ChatSession } from "../chats/session"
import { readRoleSnapshot, ROLE_SNAPSHOT_MAX_AGE_MS, type RoleSnapshot, type StoredRole } from "../discord/mirror-roles"
import { ToolError } from "../errors"
import { checkUser } from "../people/known"
import { checkServer } from "../search/scope"
import { ADMINISTRATOR, ALL_PERMISSIONS, permissionNames } from "./permissions"
import { standingOf, type Standing } from "./standing"

/** What a refusal says to do when the roles of a server are not stored. */
const READ_FIRST = "read the roles with discord_role_read method list first"

type Mirrored = Pick<ChatSession, "mirror">

/**
 * The stored roles of a server the mirror knows. `not_found` for a server the
 * mirror lacks, and for one whose roles were never read.
 */
export function requireSnapshot(session: Mirrored, server: string): RoleSnapshot {
  checkServer(session, server)
  const snapshot = readRoleSnapshot(session.mirror, server)
  if (snapshot === null) {
    throw new ToolError("not_found", `No roles of server ${server} are stored: ${READ_FIRST}.`)
  }
  return snapshot
}

/**
 * Refuses a snapshot older than `ROLE_SNAPSHOT_MAX_AGE_MS`, or expired by a
 * change of the user's own roles (read at 0). `stale`: what the call relies on
 * is out of date, and reading the roles again makes it current.
 */
export function checkFresh(snapshot: RoleSnapshot, now: number): void {
  if (now - snapshot.readAt > ROLE_SNAPSHOT_MAX_AGE_MS) {
    throw new ToolError(
      "stale",
      `The stored roles of server ${snapshot.server} are out of date: they must be under ${ROLE_SNAPSHOT_MAX_AGE_MS / 60_000} minutes old, and a change of the user's own roles expires them. Read them again with discord_role_read method list, then repeat the call.`,
    )
  }
}

/** The fresh stored roles of a server the mirror knows: `requireSnapshot` then `checkFresh`. */
export function freshSnapshot(session: Mirrored & Pick<ChatSession, "now">, server: string): RoleSnapshot {
  const snapshot = requireSnapshot(session, server)
  checkFresh(snapshot, session.now())
  return snapshot
}

/** The role of the snapshot with this id; `not_found` for one it does not list. */
export function findRole(snapshot: RoleSnapshot, id: string): StoredRole {
  const role = snapshot.roles.find((entry) => entry.id === id)
  if (role === undefined) {
    throw new ToolError(
      "not_found",
      `Role ${id} is not among the stored roles of server ${snapshot.server}: ${READ_FIRST} (it lists every role's id).`,
    )
  }
  return role
}

/**
 * The user's standing in the snapshot's server, refused (`forbidden`) when the
 * user may not manage roles there.
 */
export function checkCanManageRoles(snapshot: RoleSnapshot, owner: boolean): Standing {
  const standing = standingOf(snapshot, owner)
  if (!standing.canManageRoles) {
    throw new ToolError(
      "forbidden",
      `The user may not manage roles in server ${snapshot.server}: it takes Manage Roles, Administrator or owning the server.`,
    )
  }
  return standing
}

/**
 * Refuses a role no user could change from here (`invalid_argument`:
 * @everyone, which a write reaches only by editing its permissions, and a role
 * an integration manages) and, unless the user owns the server, one that does
 * not sit below their highest role (`forbidden`).
 */
export function checkManageable(snapshot: RoleSnapshot, role: StoredRole, standing: Standing): void {
  if (role.id === snapshot.server) {
    throw new ToolError(
      "invalid_argument",
      "@everyone, the role whose id is the server's, is held by every member and is never given, taken or deleted; only its permissions can be edited.",
    )
  }
  if (role.managed) {
    throw new ToolError(
      "invalid_argument",
      `Role ${role.id} is managed by an integration, such as a bot or a boost, and no user can give, take, edit or delete it.`,
    )
  }
  if (!standing.owner && role.position >= standing.topPosition) {
    throw new ToolError(
      "forbidden",
      `Role ${role.id} (position ${role.position}) is not below the user's highest role (position ${standing.topPosition}): only a role below it can be changed.`,
    )
  }
}

/**
 * Refuses (`forbidden`) handing out `bits`, the permissions a role would hold
 * or be granted, when they include `administrator`, which is never given from
 * here, or a permission the user lacks. `subject` starts the message and ends
 * where the permissions begin (`Role 5 holds`).
 */
export function checkHandOut(standing: Standing, bits: bigint, subject: string): void {
  if ((bits & ADMINISTRATOR) !== 0n) {
    throw new ToolError(
      "forbidden",
      `${subject} administrator, which this package never gives: a person gives it in Discord.`,
    )
  }
  const missing = standing.permissions === ALL_PERMISSIONS ? 0n : bits & ~standing.permissions
  if (missing !== 0n) {
    throw new ToolError(
      "forbidden",
      `${subject} permissions the user lacks (${permissionNames(missing).join(", ")}), and a role never hands over more than the user has.`,
    )
  }
}

/**
 * Refuses, from the snapshot alone, a role write Discord would refuse and one
 * the package never makes: the user must be allowed to manage roles, the role
 * must be one the user may change (`checkManageable`), and giving a role is
 * refused when it holds `administrator` or a permission the user lacks
 * (`checkHandOut`).
 */
export function checkRoleWrite(snapshot: RoleSnapshot, role: StoredRole, owner: boolean, give: boolean): void {
  const standing = checkCanManageRoles(snapshot, owner)
  checkManageable(snapshot, role, standing)
  if (give) checkHandOut(standing, role.permissions, `Role ${role.id} holds`)
}

/** Refuses a user the mirror does not know (`not_found`, naming it). */
export function checkUsers(session: Mirrored, users: readonly string[]): void {
  for (const user of users) checkUser(session, user)
}
