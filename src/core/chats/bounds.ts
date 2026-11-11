import { ToolError } from "../errors"
import { isSnowflake, snowflakeAt } from "../discord/snowflake"

/** The ids a `messages` read lies between, both exclusive; either may be left out. */
export type MessageBounds = { before?: string; after?: string }

/** `YYYY-MM-DD`, a UTC date. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by a zone: `Z` or `±HH:MM`. */
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/

/** What `before` and `after` accept, as told to the caller who gave something else. */
const FORMS =
  "a message id, a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone (2026-01-02T03:04:05Z or 2026-01-02T12:04:05+09:00)"

/** The most characters of a refused value an error repeats. */
const MAX_SHOWN_LENGTH = 40

function invalid(message: string): never {
  throw new ToolError("invalid_argument", message)
}

/** Whether `day` exists in month `month` (1 to 12) of `year`. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  const last = new Date(0)
  last.setUTCFullYear(year, month, 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= last.getUTCDate()
}

/** The time a date or a timestamp names, in milliseconds; `undefined` when `value` is neither. */
function timeOf(value: string): number | undefined {
  const parts = DATE_PATTERN.exec(value) ?? TIMESTAMP_PATTERN.exec(value)
  if (!parts || !isCalendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]))) return undefined
  const time = Date.parse(DATE_PATTERN.test(value) ? `${value}T00:00:00Z` : value.toUpperCase())
  return Number.isNaN(time) ? undefined : time
}

/** The instant a timestamp with a zone names, in milliseconds; `undefined` for a date alone and for anything else. */
export function timestampTime(value: string): number | undefined {
  return TIMESTAMP_PATTERN.test(value) ? timeOf(value) : undefined
}

/** The snowflake `before` or `after` names: the id itself, or the id of the instant a date or a timestamp names. */
function boundOf(name: "before" | "after", value: string): string {
  const shown = JSON.stringify(value.slice(0, MAX_SHOWN_LENGTH))
  if (isSnowflake(value)) return value
  const time = timeOf(value)
  if (time === undefined) invalid(`\`${name}\` must be ${FORMS}; got ${shown}.`)
  const start = BigInt(snowflakeAt(time))
  const bound = String(name === "after" && start > 0n ? start - 1n : start)
  if (name === "before" ? !isSnowflake(bound) : bound !== "0" && !isSnowflake(bound)) {
    invalid(`\`${name}\` is outside the dates Discord ids cover: 2015-01-01 to about 2084.`)
  }
  return bound
}

/** Pins page by the time they were pinned, so only a date or a timestamp names a place in them. */
const PIN_TIME_FORMS = "a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone (2026-01-02T03:04:05Z)"

/**
 * The instant a pin `before` names, as an ISO 8601 UTC string. `invalid_argument`
 * for a message id (pins page by pin time, not by message) and for any other form.
 */
export function parsePinTime(value: string): string {
  const shown = JSON.stringify(value.slice(0, MAX_SHOWN_LENGTH))
  if (isSnowflake(value)) invalid(`Pins page by pin time: \`before\` must be ${PIN_TIME_FORMS}, not a message id.`)
  const time = timeOf(value)
  if (time === undefined) invalid(`\`before\` must be ${PIN_TIME_FORMS}; got ${shown}.`)
  return new Date(time).toISOString()
}

/**
 * Turns `before` and `after` into exclusive snowflake bounds. A `before` time
 * keeps messages made before that instant; an `after` time keeps those made at
 * or after it. `invalid_argument` for any other form, for a date outside the
 * years ids cover, and when `after` is not below `before`.
 */
export function parseBounds(before?: string, after?: string): MessageBounds {
  const bounds: MessageBounds = {}
  if (before !== undefined) bounds.before = boundOf("before", before)
  if (after !== undefined) bounds.after = boundOf("after", after)
  if (bounds.before !== undefined && bounds.after !== undefined && BigInt(bounds.after) >= BigInt(bounds.before)) {
    invalid("`after` must be earlier than `before`.")
  }
  return bounds
}
