import { invalid } from "../chats/args"
import { parseBounds } from "../chats/bounds"
import { isSnowflake } from "../discord/snowflake"
import { SEARCH_METHODS, type SearchMethod, type SearchReadInput } from "./schemas"

/** How many messages a search returns when `limit` is left out. */
export const SEARCH_LIMIT_DEFAULT = 25

/** The most messages a search of the mirror returns in one call. */
export const MIRROR_LIMIT_MAX = 100

/** The most messages a search of Discord returns in one call. */
export const DISCORD_LIMIT_MAX = 25

/** The most messages each method returns in one call. */
const LIMIT_MAX: Record<SearchMethod, number> = { mirror: MIRROR_LIMIT_MAX, discord: DISCORD_LIMIT_MAX }

/** The arguments every method takes. */
const ALWAYS: readonly (keyof SearchReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `SEARCH_METHODS`. */
const ALLOWED: Record<SearchMethod, readonly (keyof SearchReadInput)[]> = {
  mirror: [
    "query",
    "channel",
    "server",
    "author",
    "mentions",
    "has",
    "pinned",
    "reacted",
    "emoji",
    "threads",
    "before",
    "after",
    "limit",
  ],
  discord: ["query", "channel", "server", "author", "mentions", "has", "pinned", "before", "after", "limit"],
}

/** The arguments that narrow a search to messages with a property; a search needs at least one the method takes. */
const FILTER_ARGUMENTS: readonly (keyof SearchReadInput)[] = [
  "query",
  "author",
  "mentions",
  "has",
  "pinned",
  "reacted",
  "emoji",
]

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["channel", "server", "author", "mentions"] as const

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, an id that is not a snowflake, `channel` together
 * with `server`, `threads` without `channel`, a repeated `has`, a bound that is
 * not an id, a date or a timestamp, a search with no filter, and a `limit` over
 * the method's maximum. The message for an argument only another method takes
 * names that method.
 */
export function checkArgs(args: SearchReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof SearchReadInput)) {
      const takenBy = SEARCH_METHODS.filter((method) => ALLOWED[method].includes(field as keyof SearchReadInput))
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
  if (args.channel !== undefined && args.server !== undefined) {
    invalid("Give `channel` or `server`, not both: a channel already belongs to one server.")
  }
  if (args.threads === true && args.channel === undefined) {
    invalid("`threads` needs `channel`: the id of the chat whose threads to search as well.")
  }
  if (args.has !== undefined && new Set(args.has).size !== args.has.length) {
    invalid("`has` lists each of its values once.")
  }
  parseBounds(args.before, args.after)
  const filters = FILTER_ARGUMENTS.filter((field) => takes.includes(field))
  if (filters.every((field) => args[field] === undefined)) {
    invalid(
      `A search needs at least one of ${filters.join(", ")}; to read a chat without a search, use discord_chat_read method messages.`,
    )
  }
  const max = LIMIT_MAX[args.method]
  if (args.limit !== undefined && args.limit > max) invalid(`limit is at most ${max} for method ${args.method}.`)
}
