import { invalid } from "../chats/args"
import { timeZone } from "../discord/identity"
import type { DayCount } from "./schemas"

/**
 * The length of the buckets messages are grouped in before they are given a
 * day, in milliseconds. SQLite cannot cut days in an IANA zone, and every
 * real zone's offset from UTC is a whole number of quarter hours (+05:45
 * Nepal is the finest), so a quarter hour never straddles a local midnight.
 */
export const QUARTER_HOUR_MS = 15 * 60 * 1000

/** The zone days are cut in when `time_zone` is left out and the machine names none. */
const FALLBACK_ZONE = "UTC"

/** The messages of one quarter hour: `bucket` is its start in `QUARTER_HOUR_MS` units since the Unix epoch. */
export type QuarterHourCount = { bucket: number; messages: number; from_me: number }

/** The canonical name of an IANA time zone; `invalid_argument` for anything the runtime does not know. */
export function resolveTimeZone(name: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: name }).resolvedOptions().timeZone
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return invalid(
      `\`time_zone\` must be an IANA time zone name such as Asia/Tokyo or UTC; got ${JSON.stringify(name)}.`,
    )
  }
}

/** The zone days are cut in: the one named, else this machine's, else UTC. */
export function zoneOf(name: string | undefined): string {
  return resolveTimeZone(name ?? timeZone() ?? FALLBACK_ZONE)
}

/** Counts per local day in `zone`, the oldest day first; a day without messages is left out. */
export function localDays(buckets: readonly QuarterHourCount[], zone: string): DayCount[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
  const days = new Map<string, DayCount>()
  for (const { bucket, messages, from_me } of buckets) {
    const parts = Object.fromEntries(format.formatToParts(bucket * QUARTER_HOUR_MS).map((p) => [p.type, p.value]))
    const day = `${parts.year}-${parts.month}-${parts.day}`
    const total = days.get(day) ?? { day, messages: 0, from_me: 0 }
    total.messages += messages
    total.from_me += from_me
    days.set(day, total)
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}
