import { invalid } from "../chats/args"
import { isSnowflake } from "../discord/snowflake"
import { SERVER_METHODS, type ServerMethod, type ServerReadInput } from "./schemas"

/** The arguments every method takes. */
const ALWAYS: readonly (keyof ServerReadInput)[] = ["account", "method", "server"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `SERVER_METHODS`. */
const ALLOWED: Record<ServerMethod, readonly (keyof ServerReadInput)[]> = {
  info: [],
  roles: [],
  emojis: ["query", "limit"],
}

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take and a server that is not a snowflake. The message
 * for an argument only another method takes names that method.
 */
export function checkArgs(args: ServerReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof ServerReadInput)) {
      const takenBy = SERVER_METHODS.filter((method) => ALLOWED[method].includes(field as keyof ServerReadInput))
      const only =
        takenBy.length === 1
          ? ` Only method ${takenBy[0]} takes it.`
          : takenBy.length > 1
            ? ` Only methods ${takenBy.slice(0, -1).join(", ")} and ${takenBy.at(-1)} take it.`
            : ""
      invalid(`${field} is not an argument of method ${args.method}; it takes: ${takes.join(", ")}.${only}`)
    }
  }
  if (!isSnowflake(args.server)) invalid("`server` must be an id: a number of up to 20 digits, not a name.")
}
