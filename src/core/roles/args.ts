import { invalid } from "../chats/args"
import { isSnowflake } from "../discord/snowflake"
import { checkMethodArgs } from "../people/method-args"
import { ROLE_METHODS, type RoleMethod, type RoleReadInput } from "./schemas"

/** The arguments every method takes. */
const ALWAYS: readonly (keyof RoleReadInput)[] = ["account", "method", "server"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `ROLE_METHODS`. */
const ALLOWED: Record<RoleMethod, readonly (keyof RoleReadInput)[]> = {
  list: [],
  role: ["role"],
  members: ["role"],
}

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["server", "role"] as const

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, an id that is not a snowflake, a method that needs
 * a `role` without one, and `members` of @everyone, which Discord does not
 * list. The message for an argument only another method takes names that method.
 */
export function checkArgs(args: RoleReadInput): void {
  checkMethodArgs(args, ROLE_METHODS, ALWAYS, ALLOWED)
  for (const field of ID_ARGUMENTS) {
    const id = args[field]
    if (id !== undefined && !isSnowflake(id)) {
      invalid(`\`${field}\` must be an id: a number of up to 20 digits, not a name.`)
    }
  }
  if (ALLOWED[args.method].includes("role") && args.role === undefined) {
    invalid(`Method ${args.method} needs \`role\`: the id of a role, from method list.`)
  }
  if (args.method === "members" && args.role === args.server) {
    invalid("Discord does not list the members of @everyone, the role whose id is the server's: every member holds it.")
  }
}
