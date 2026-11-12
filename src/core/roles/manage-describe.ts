import { serverName, withMirror } from "../chats/describe"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { findRole, requireSnapshot } from "./assign-check"
import type { RoleWriteInput } from "./assign-schemas"
import { createBits, editBits } from "./manage-plan"
import { NO_COLOR, type RoleCreateInput, type RoleDeleteInput, type RoleEditInput } from "./manage-schemas"
import { permissionNames, strongNames } from "./permissions"
import { reasonText, rolePins, strongFacts } from "./role-describe"

/** The `Color` fact: the color as `#rrggbb`, lower case, or `None`. */
const colorFact = (color: string): CallFact => ({
  label: "Color",
  value: color === NO_COLOR ? { text: "None" } : color.toLowerCase(),
})

/** A `Yes` or `No` fact. */
const yesNoFact = (label: string, value: boolean): CallFact => ({ label, value: { text: value ? "Yes" : "No" } })

/** The facts of the appearance fields a call gives, in the order they are shown: `Color`, `Listed apart`, `Mentionable`. */
function appearanceFacts({ color, hoist, mentionable }: Pick<RoleEditInput, "color" | "hoist" | "mentionable">) {
  return [
    ...(color === undefined ? [] : [colorFact(color)]),
    ...(hoist === undefined ? [] : [yesNoFact("Listed apart", hoist)]),
    ...(mentionable === undefined ? [] : [yesNoFact("Mentionable", mentionable)]),
  ]
}

/**
 * What a creation will do, from the mirror alone: the server, the name as
 * given, the appearance fields given, every permission the role will hold and
 * the strong ones among them. The reason is the text. `not_found` when the
 * mirror lacks the server or its roles, which the call itself refuses.
 */
export function describeRoleCreate(input: RoleCreateInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(input.account, ctx, (mirror): CallDescription => {
    requireSnapshot({ mirror }, input.server)
    const bits = createBits(input)
    const names = permissionNames(bits)
    return {
      headline: { text: "About to create the role {name}", values: { name: input.name } },
      facts: [
        { label: "Server", value: serverName(mirror, input.server) },
        { label: "New name", value: input.name },
        ...strongFacts(strongNames(bits)),
        ...appearanceFacts(input),
        { label: "Permissions", value: names.length === 0 ? { text: "None" } : names.join(", ") },
      ],
      ...reasonText(input.reason),
    }
  })
}

/**
 * What a write to an existing role will do: the headline and facts `build`
 * makes after the server and the role by its name in the stored roles, the
 * reason as the text, and the role's bits and position pinned, so a re-read that
 * changed them makes the call `stale`. `not_found` when the mirror lacks the
 * server, its roles or the role, which the call itself refuses.
 */
function describeRoleWrite(
  input: RoleWriteInput,
  ctx: ToolContext,
  build: (roleName: string) => { headline: CallHeadline; more: CallFact[] },
): Promise<CallDescription> {
  return withMirror(input.account, ctx, (mirror): CallDescription => {
    const role = findRole(requireSnapshot({ mirror }, input.server), input.role)
    const roleName = role.name ?? role.id
    const { headline, more } = build(roleName)
    return {
      headline,
      facts: [
        { label: "Server", value: serverName(mirror, input.server) },
        { label: "Role", value: roleName },
        ...more,
      ],
      ...reasonText(input.reason),
      pins: rolePins(role),
    }
  })
}

/** What an edit will do: the server, the role, the fields given, the permissions granted and revoked and the strong ones granted. */
export function describeRoleEdit(input: RoleEditInput, ctx: ToolContext): Promise<CallDescription> {
  return describeRoleWrite(input, ctx, (roleName) => {
    const bits = editBits(input)
    return {
      headline: { text: "About to edit {role}", values: { role: roleName } },
      more: [
        ...(input.name === undefined ? [] : [{ label: "New name", value: input.name }]),
        ...strongFacts(strongNames(bits.grant)),
        ...appearanceFacts(input),
        ...(input.grant === undefined ? [] : [{ label: "Grant", value: permissionNames(bits.grant).join(", ") }]),
        ...(input.revoke === undefined ? [] : [{ label: "Revoke", value: permissionNames(bits.revoke).join(", ") }]),
      ],
    }
  })
}

/** What a deletion will do: the server and the role. */
export function describeRoleDelete(input: RoleDeleteInput, ctx: ToolContext): Promise<CallDescription> {
  return describeRoleWrite(input, ctx, (roleName) => ({
    headline: { text: "About to delete {role}", values: { role: roleName } },
    more: [],
  }))
}
