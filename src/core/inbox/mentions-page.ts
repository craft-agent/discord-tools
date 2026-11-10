import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { isSnowflake } from "../discord/snowflake"
import { invalidResponse } from "../discord/sync-page"

/** What one request of Discord's mentions returned, once validated. */
export type MentionsPage = {
  /** The messages, newest first, each once. */
  messages: JsonRecord[]
  /** Whether Discord answered with as many messages as asked for, so older ones may follow. */
  full: boolean
}

/**
 * Validates an answer of Discord's mentions: a list of messages. Anything else
 * is an `upstream_error`. An entry that is not an object, has no valid id,
 * repeats an earlier one or is not below `before` is left out, so paging by
 * the oldest message always moves back; the rest is put in id order, newest
 * first, whatever order Discord used.
 */
export function mentionsPage(value: unknown, before: string | undefined, limit: number): MentionsPage {
  if (!Array.isArray(value)) invalidResponse()
  const seen = new Set<string>()
  const messages = value
    .filter((entry): entry is JsonRecord => isRecord(entry) && isSnowflake(entry.id))
    .filter((message) => {
      const id = message.id as string
      if (seen.has(id) || (before !== undefined && BigInt(id) >= BigInt(before))) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => {
      const [x, y] = [BigInt(a.id as string), BigInt(b.id as string)]
      return x === y ? 0 : x > y ? -1 : 1
    })
  return { messages, full: value.length >= limit }
}
