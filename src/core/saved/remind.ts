import { invalid } from "../chats/args"
import { timestampTime } from "../chats/bounds"

/** What `remind_at` accepts, as told to the caller who gave something else. */
const REMIND_FORMS = "a timestamp with a zone (2026-01-02T03:04:05Z or 2026-01-02T12:04:05+09:00)"

/** The most characters of a refused value an error repeats. */
const MAX_SHOWN_LENGTH = 40

/** The instant `remind_at` names, as an ISO 8601 UTC string; `invalid_argument` for anything but a timestamp with a zone. */
export function remindTime(remindAt: string): string {
  const time = timestampTime(remindAt)
  if (time === undefined) {
    invalid(`\`remind_at\` must be ${REMIND_FORMS}; got ${JSON.stringify(remindAt.slice(0, MAX_SHOWN_LENGTH))}.`)
  }
  return new Date(time).toISOString()
}

/** Refuses a reminder time that is not later than `now` (milliseconds) as `invalid_argument`. */
export function requireFuture(remindTimeUtc: string, now: number): void {
  if (Date.parse(remindTimeUtc) <= now) invalid("`remind_at` must be later than now.")
}
