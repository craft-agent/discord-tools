import { serverName, withMirror } from "../chats/describe"
import { userLookup } from "../chats/dms"
import { displayName } from "../chats/format"
import type { StoredRole } from "../discord/mirror-roles"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import { checkUsers, findRole, requireSnapshot } from "./assign-check"
import type { RoleAssignInput, RoleUnassignInput, RoleWriteInput } from "./assign-schemas"
import { strongNames } from "./permissions"

/** How many member names the headline names before it counts the rest. */
const HEADLINE_NAMES = 3

/** The members for the headline: up to `HEADLINE_NAMES` names, then how many others there are. */
function headlineMembers(names: readonly string[]): string {
  const shown = names.slice(0, HEADLINE_NAMES).join(", ")
  const others = names.length - HEADLINE_NAMES
  if (others <= 0) return shown
  return `${shown} and ${others} ${others === 1 ? "other" : "others"}`
}

/** What the prompt pins of the role besides what it shows: its permission bits, position and whether an integration manages it. */
function rolePins(role: StoredRole): Record<string, string> {
  return {
    role_permissions: role.permissions.toString(),
    role_position: String(role.position),
    role_managed: String(role.managed),
  }
}

/**
 * What a role write will do, from the mirror alone: the server, the role by its
 * name in the stored roles, the members by the names the mirror holds, and,
 * for giving, the strong permissions the role holds. The reason is the text.
 * `not_found` when the mirror lacks the server, its roles, the role or a user,
 * which the call itself refuses. The role's bits and position are pinned, so a
 * re-read that changed them makes the call `stale`.
 */
function describeRoleWrite(
  input: RoleWriteInput,
  users: readonly string[],
  give: boolean,
  ctx: ToolContext,
): Promise<CallDescription> {
  return withMirror(input.account, ctx, (mirror): CallDescription => {
    const snapshot = requireSnapshot({ mirror }, input.server)
    const role = findRole(snapshot, input.role)
    checkUsers({ mirror }, users)
    const user = userLookup(mirror)
    const names = users.map((id) => displayName(user(id)) ?? id)
    const roleName = role.name ?? role.id
    const strong = give ? strongNames(role.permissions) : []
    const facts: CallFact[] = [
      { label: "Server", value: serverName(mirror, input.server) },
      { label: "Role", value: roleName },
      { label: "Members", value: names.join(", ") },
      ...(strong.length === 0 ? [] : [{ label: "Strong permissions", value: strong.join(", ") }]),
    ]
    return {
      headline: give
        ? { text: "About to give {role} to {members}", values: { role: roleName, members: headlineMembers(names) } }
        : { text: "About to take {role} from {member}", values: { role: roleName, member: names[0]! } },
      facts,
      ...(input.reason === undefined ? {} : { text: { label: "Reason", body: input.reason } }),
      pins: rolePins(role),
    }
  })
}

/** What giving a role will do: the server, the role, whom it reaches, the strong permissions it hands over, the reason. */
export function describeRoleAssign(input: RoleAssignInput, ctx: ToolContext): Promise<CallDescription> {
  return describeRoleWrite(input, input.users, true, ctx)
}

/** What taking a role away will do: the server, the role, whom it is taken from, the reason. */
export function describeRoleUnassign(input: RoleUnassignInput, ctx: ToolContext): Promise<CallDescription> {
  return describeRoleWrite(input, [input.user], false, ctx)
}
