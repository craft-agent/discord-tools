import { invalid } from "../chats/args"
import { isSnowflake } from "../discord/snowflake"
import { checkMethodArgs } from "../people/method-args"
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
  checkMethodArgs(args, SERVER_METHODS, ALWAYS, ALLOWED)
  if (!isSnowflake(args.server)) invalid("`server` must be an id: a number of up to 20 digits, not a name.")
}
