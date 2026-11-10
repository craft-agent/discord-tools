import { invalid } from "../chats/args"
import { parseBounds } from "../chats/bounds"
import { isToolError } from "../errors"
import { isSnowflake } from "../discord/snowflake"
import { INBOX_METHODS, type InboxMethod, type InboxReadInput } from "./schemas"

/** How many mentions `mentions` returns when `limit` is left out. */
export const MENTIONS_LIMIT_DEFAULT = 25

/** How many chats `waiting` returns when `limit` is left out. */
export const WAITING_LIMIT_DEFAULT = 30

/** The most each method returns in one call. */
const LIMIT_MAX: Record<InboxMethod, number> = { mentions: 100, waiting: 100 }

/** The arguments every method takes. */
const ALWAYS: readonly (keyof InboxReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `INBOX_METHODS`. */
const ALLOWED: Record<InboxMethod, readonly (keyof InboxReadInput)[]> = {
  mentions: ["server", "before", "limit"],
  waiting: ["server", "since", "limit"],
}

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["server", "before"] as const

/** What `since` accepts, as told to the caller who gave something else. */
const SINCE_FORMS =
  "a message id, a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone (2026-01-02T03:04:05Z or 2026-01-02T12:04:05+09:00)"

/** The most characters of a refused value an error repeats. */
const MAX_SHOWN_LENGTH = 40

/**
 * The message id after which `since` lets messages count: the id itself, or
 * the id just below the instant a date or a timestamp names, so a message
 * made at that instant counts. `invalid_argument` for any other form.
 */
export function sinceId(since: string): string {
  const shown = JSON.stringify(since.slice(0, MAX_SHOWN_LENGTH))
  if (isSnowflake(since)) return since
  try {
    const { after } = parseBounds(undefined, since)
    if (after !== undefined) return after
  } catch (error) {
    if (!isToolError(error)) throw error
  }
  return invalid(`\`since\` must be ${SINCE_FORMS}; got ${shown}.`)
}

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, an id that is not a snowflake, a `since` that is
 * not an id, a date or a timestamp, and a `limit` over the method's maximum.
 * The message for an argument only another method takes names that method.
 */
export function checkArgs(args: InboxReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof InboxReadInput)) {
      const takenBy = INBOX_METHODS.filter((method) => ALLOWED[method].includes(field as keyof InboxReadInput))
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
  if (args.since !== undefined) sinceId(args.since)
  const max = LIMIT_MAX[args.method]
  if (args.limit !== undefined && args.limit > max) invalid(`limit is at most ${max} for method ${args.method}.`)
}
