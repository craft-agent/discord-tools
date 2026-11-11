import { invalid } from "../chats/args"
import { isSnowflake } from "../discord/snowflake"
import { PEOPLE_METHODS, type PeopleMethod, type PeopleReadInput } from "./schemas"

/** The arguments every method takes. */
const ALWAYS: readonly (keyof PeopleReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `PEOPLE_METHODS`. */
const ALLOWED: Record<PeopleMethod, readonly (keyof PeopleReadInput)[]> = {
  friends: ["query"],
  notes: ["user"],
}

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["user"] as const

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, and an id that is not a snowflake. The message for
 * an argument only another method takes names that method.
 */
export function checkArgs(args: PeopleReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof PeopleReadInput)) {
      const takenBy = PEOPLE_METHODS.filter((method) => ALLOWED[method].includes(field as keyof PeopleReadInput))
      const only = takenBy.length > 0 ? ` Only method ${takenBy.join(" and ")} takes it.` : ""
      invalid(`${field} is not an argument of method ${args.method}; it takes: ${takes.join(", ")}.${only}`)
    }
  }
  for (const field of ID_ARGUMENTS) {
    const id = args[field]
    if (id !== undefined && !isSnowflake(id)) {
      invalid(`\`${field}\` must be an id: a number of up to 20 digits, not a name.`)
    }
  }
}
