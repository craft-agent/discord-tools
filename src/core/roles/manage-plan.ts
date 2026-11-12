import { intOrNull, type JsonRecord } from "../discord/ingest-values"
import type { StoredRole } from "../discord/mirror-roles"
import { ToolError } from "../errors"
import { rolesPath } from "../people/role-list"
import { NO_COLOR, type RoleCreateInput, type RoleEditInput } from "./manage-schemas"
import { parsePermissionNames } from "./permissions"
import type { RoleRequest } from "./role-write"

/** The number Discord takes for a color: `#rrggbb` as its three bytes, `none` as 0. */
export function colorValue(color: string): number {
  return color === NO_COLOR ? 0 : Number.parseInt(color.slice(1), 16)
}

/** The permission bits a creation asks for; `invalid_argument` for a name Discord has no flag of. */
export function createBits(input: Pick<RoleCreateInput, "permissions">): bigint {
  return parsePermissionNames(input.permissions ?? [])
}

/** The request of a creation: `permissions` is always sent, as the decimal text of the bit set, and the other fields only when given. */
export function createRequest(input: RoleCreateInput, permissions: bigint): RoleRequest {
  const { server, name, color, hoist, mentionable } = input
  return {
    method: "POST",
    path: rolesPath(server),
    body: {
      name,
      permissions: permissions.toString(),
      ...(color === undefined ? {} : { color: colorValue(color) }),
      ...(hoist === undefined ? {} : { hoist }),
      ...(mentionable === undefined ? {} : { mentionable }),
    },
  }
}

/** Where Discord keeps one role: `PATCH` changes it, `DELETE` removes it. */
export const rolePath = (server: string, role: string) => `${rolesPath(server)}/${role}`

/** The permission bits an edit grants and revokes. */
export type EditBits = { grant: bigint; revoke: bigint }

/**
 * The bits an edit grants and revokes. `invalid_argument` for a name Discord
 * has no flag of, and for a name in both lists, which would leave it unclear
 * whether the role ends with the permission.
 */
export function editBits({ grant = [], revoke = [] }: Pick<RoleEditInput, "grant" | "revoke">): EditBits {
  const both = grant.filter((name) => revoke.includes(name))
  if (both.length > 0) {
    throw new ToolError(
      "invalid_argument",
      `${both.join(", ")} is in both grant and revoke: name a permission in one of them.`,
    )
  }
  return { grant: parsePermissionNames(grant), revoke: parsePermissionNames(revoke) }
}

/** Refuses an edit of @everyone that asks for more than its permissions (`invalid_argument`). */
export function checkEveryoneEdit(input: Pick<RoleEditInput, "name" | "color" | "hoist" | "mentionable">): void {
  const given = (["name", "color", "hoist", "mentionable"] as const).filter((field) => input[field] !== undefined)
  if (given.length > 0) {
    throw new ToolError(
      "invalid_argument",
      `@everyone has only its permissions to edit (grant, revoke): leave out ${given.join(", ")}.`,
    )
  }
}

/** What an edit changes: the body of the request with only those fields, their names, and the permission set the role ends with. */
export type EditPlan = { body: JsonRecord; changed: string[]; permissions: bigint }

/**
 * Works out an edit against the stored role: a field is changed when it is
 * given and differs from what the snapshot holds (`raw`, the role as Discord
 * sent it), and `permissions` is the role's whole new set, the stored bits
 * (those without a name included) with `grant` set and `revoke` cleared.
 * `invalid_argument` when nothing changes.
 */
export function planEdit(input: RoleEditInput, bits: EditBits, role: StoredRole, raw: JsonRecord | null): EditPlan {
  const body: JsonRecord = {}
  if (input.name !== undefined && input.name !== role.name) body.name = input.name
  if (input.color !== undefined && colorValue(input.color) !== (intOrNull(raw?.color) ?? 0)) {
    body.color = colorValue(input.color)
  }
  if (input.hoist !== undefined && input.hoist !== (raw?.hoist === true)) body.hoist = input.hoist
  if (input.mentionable !== undefined && input.mentionable !== (raw?.mentionable === true)) {
    body.mentionable = input.mentionable
  }
  const permissions = (role.permissions | bits.grant) & ~bits.revoke
  if (permissions !== role.permissions) body.permissions = permissions.toString()
  const changed = Object.keys(body)
  if (changed.length === 0) {
    throw new ToolError(
      "invalid_argument",
      `Role ${role.id} already is as asked, so the edit would change nothing: give a value that differs from the stored role.`,
    )
  }
  return { body, changed, permissions }
}

/** The request of an edit: only the fields that change. */
export function editRequest(server: string, role: string, plan: EditPlan): RoleRequest {
  return { method: "PATCH", path: rolePath(server, role), body: plan.body }
}

/** The request of a deletion. */
export function deleteRequest(server: string, role: string): RoleRequest {
  return { method: "DELETE", path: rolePath(server, role) }
}
