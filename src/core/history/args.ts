import { invalid } from "../chats/args"
import { type MessageBounds, parseBounds } from "../chats/bounds"
import { isSnowflake, snowflakeAt } from "../discord/snowflake"
import { resolveTimeZone } from "./days"
import { HISTORY_METHODS, type HistoryMethod, type HistoryReadInput } from "./schemas"

/** How far back `counts` looks when `after` is left out: 30 days, in milliseconds. */
export const COUNTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** How many chats or authors `counts` returns when `limit` is left out. */
export const COUNTS_LIMIT_DEFAULT = 20

/** How many days `counts` returns when `limit` is left out and `by` is `day`. */
export const DAYS_LIMIT_DEFAULT = 30

/** The most rows each method returns in one call. */
const LIMIT_MAX: Record<HistoryMethod, number> = { counts: 100 }

/** The arguments every method takes. */
const ALWAYS: readonly (keyof HistoryReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `HISTORY_METHODS`. */
const ALLOWED: Record<HistoryMethod, readonly (keyof HistoryReadInput)[]> = {
  counts: ["by", "after", "before", "server", "chat", "time_zone", "limit"],
}

/** The arguments that name an object by its id. */
const ID_ARGUMENTS = ["server", "chat"] as const

/**
 * The window `counts` reads as exclusive snowflake bounds: `after` is the
 * start the arguments name, else 30 days before `now`; `before` is left out
 * when the arguments give none. `invalid_argument` for a bound in no accepted
 * form, for `after` not earlier than `before`, and for a `before` that is not
 * after the default start, since the window would then be empty.
 */
export function windowOf(args: HistoryReadInput, now: number): MessageBounds & { after: string } {
  const bounds = parseBounds(args.before, args.after)
  if (bounds.after !== undefined) return { ...bounds, after: bounds.after }
  const after = snowflakeAt(now - COUNTS_WINDOW_MS)
  if (bounds.before !== undefined && BigInt(bounds.before) <= BigInt(after)) {
    invalid("`before` is older than the default window (the past 30 days): give `after` too.")
  }
  return { ...bounds, after }
}

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, an id that is not a snowflake, a bound that is not
 * an id, a date or a timestamp (or `after` not earlier than `before`), a
 * `time_zone` that is not an IANA zone, and a `limit` over the method's
 * maximum. The message for an argument only another method takes names that
 * method.
 */
export function checkArgs(args: HistoryReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof HistoryReadInput)) {
      const takenBy = HISTORY_METHODS.filter((method) => ALLOWED[method].includes(field as keyof HistoryReadInput))
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
  parseBounds(args.before, args.after)
  if (args.time_zone !== undefined) resolveTimeZone(args.time_zone)
  const max = LIMIT_MAX[args.method]
  if (args.limit !== undefined && args.limit > max) invalid(`limit is at most ${max} for method ${args.method}.`)
}
