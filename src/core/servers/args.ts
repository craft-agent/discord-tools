import { invalid } from "../chats/args"
import { isSnowflake } from "../discord/snowflake"
import { checkMethodArgs } from "../people/method-args"
import {
  EMOJIS_LIMIT_MAX,
  EVENTS_LIMIT_MAX,
  INVITES_LIMIT_MAX,
  SERVER_METHODS,
  type ServerMethod,
  type ServerReadInput,
} from "./schemas"

/** The arguments every method takes. */
const ALWAYS: readonly (keyof ServerReadInput)[] = ["account", "method", "server"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `SERVER_METHODS`. */
const ALLOWED: Record<ServerMethod, readonly (keyof ServerReadInput)[]> = {
  info: [],
  roles: [],
  emojis: ["query", "limit"],
  events: ["event", "after", "limit"],
  invites: ["limit"],
}

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["server", "event", "after"] as const

/** The most `limit` allows for each method that takes it; the schema's bound is the largest of them. */
const LIMIT_MAX: Partial<Record<ServerMethod, number>> = {
  emojis: EMOJIS_LIMIT_MAX,
  events: EVENTS_LIMIT_MAX,
  invites: INVITES_LIMIT_MAX,
}

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, `after` without the `event` it pages, an id that is
 * not a snowflake and a `limit` above the method's maximum. The message for an
 * argument only another method takes names that method.
 */
export function checkArgs(args: ServerReadInput): void {
  checkMethodArgs(args, SERVER_METHODS, ALWAYS, ALLOWED)
  for (const field of ID_ARGUMENTS) {
    const id = args[field]
    if (id !== undefined && !isSnowflake(id)) {
      invalid(`\`${field}\` must be an id: a number of up to 20 digits, not a name.`)
    }
  }
  if (args.after !== undefined && args.event === undefined) {
    invalid("`after` pages the interested users of `event`: give `event` with it.")
  }
  const max = LIMIT_MAX[args.method]
  if (args.limit !== undefined && max !== undefined && args.limit > max) {
    invalid(`\`limit\` of method ${args.method} is at most ${max}.`)
  }
}
