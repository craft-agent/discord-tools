import type { StoredRole } from "../discord/mirror-roles"
import type { CallDescription, CallFact } from "../tool"

/** What the prompt pins of the role besides what it shows: its permission bits, position and whether an integration manages it. */
export function rolePins(role: StoredRole): Record<string, string> {
  return {
    role_permissions: role.permissions.toString(),
    role_position: String(role.position),
    role_managed: String(role.managed),
  }
}

/** The `Strong permissions` fact for the strong permissions given; none when there are none. */
export function strongFacts(strong: readonly string[]): CallFact[] {
  return strong.length === 0 ? [] : [{ label: "Strong permissions", value: strong.join(", ") }]
}

/** The `reason` of a call as the prompt's text, verbatim; none when the call gives none. */
export function reasonText(reason: string | undefined): Pick<CallDescription, "text"> {
  return reason === undefined ? {} : { text: { label: "Reason", body: reason } }
}
