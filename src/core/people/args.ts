import { invalid } from "../chats/args"
import { isSnowflake } from "../discord/snowflake"
import { PEOPLE_METHODS, type PeopleMethod, type PeopleReadInput } from "./schemas"

/** The arguments every method takes. */
const ALWAYS: readonly (keyof PeopleReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `PEOPLE_METHODS`. */
const ALLOWED: Record<PeopleMethod, readonly (keyof PeopleReadInput)[]> = {
  friends: ["query"],
  notes: ["user"],
  profile: ["user", "server"],
  member: ["user", "server"],
  members: ["server", "query", "limit"],
}

/** The arguments a method cannot run without; each is also in its `ALLOWED`. */
const REQUIRED: Partial<Record<PeopleMethod, readonly (keyof PeopleReadInput)[]>> = {
  profile: ["user"],
  member: ["user", "server"],
  members: ["server", "query"],
}

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["user", "server"] as const

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, one it needs and lacks, and an id that is not a
 * snowflake. The message for an argument only another method takes names that
 * method.
 */
export function checkArgs(args: PeopleReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof PeopleReadInput)) {
      const takenBy = PEOPLE_METHODS.filter((method) => ALLOWED[method].includes(field as keyof PeopleReadInput))
      const only =
        takenBy.length === 1
          ? ` Only method ${takenBy[0]} takes it.`
          : takenBy.length > 1
            ? ` Only methods ${takenBy.slice(0, -1).join(", ")} and ${takenBy.at(-1)} take it.`
            : ""
      invalid(`${field} is not an argument of method ${args.method}; it takes: ${takes.join(", ")}.${only}`)
    }
  }
  for (const field of REQUIRED[args.method] ?? []) {
    if (args[field] === undefined) invalid(`Method ${args.method} needs \`${field}\`.`)
  }
  for (const field of ID_ARGUMENTS) {
    const id = args[field]
    if (id !== undefined && !isSnowflake(id)) {
      invalid(`\`${field}\` must be an id: a number of up to 20 digits, not a name.`)
    }
  }
}
