import { parseBounds } from "../chats/bounds"
import { idTime } from "../chats/format"
import { snowflakeAt } from "../discord/snowflake"

/** How far back the window of method `suggest` reaches when `after` is left out, in days. */
export const SUGGEST_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** The window method `suggest` looks at: messages with an id above `after`, which is exclusive. */
export type SuggestWindow = {
  /** The exclusive lower snowflake bound. */
  after: string
  /** The instant the window starts, ISO 8601 UTC. */
  since: string
  /** The date part of `since`. */
  sinceDate: string
}

/** The window `after` names (see `parseBounds`), or the last `SUGGEST_DAYS` days before `now` when it is left out. */
export function suggestWindow(after: string | undefined, now: number): SuggestWindow {
  const start = BigInt(snowflakeAt(now - SUGGEST_DAYS * DAY_MS))
  const bound = parseBounds(undefined, after).after ?? String(start > 0n ? start - 1n : start)
  const since = idTime(String(BigInt(bound) + 1n))
  return { after: bound, since, sinceDate: since.slice(0, 10) }
}
