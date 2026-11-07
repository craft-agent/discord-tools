import { ToolError } from "../errors"
import { isRecord, type JsonRecord } from "./ingest-values"
import { isSnowflake } from "./snowflake"

export type HistoryPage = {
  messages: JsonRecord[]
  newest?: string
  oldest?: string
  complete: boolean
  range: { after: string; before: string }
}

/** Channel types of a DM and a group DM: private channels, never part of a server. */
export const PRIVATE_CHANNEL_TYPES = [1, 3]

export function invalidResponse(): never {
  throw new ToolError("upstream_error", "Discord returned a response of an unexpected shape.")
}

/** Validates a list response: an array of objects with distinct snowflake ids. */
export function idRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) invalidResponse()
  const seen = new Set<string>()
  for (const row of value) {
    if (!isRecord(row) || !isSnowflake(row.id) || seen.has(row.id)) invalidResponse()
    seen.add(row.id)
  }
  return value as JsonRecord[]
}

/** Validates a channel list: `idRecords` whose rows have an integer type, a valid last message id and, for a server's list, only that server's `guild_id` and no private channel (none for a private list). */
export function channelRecords(value: unknown, server?: string): JsonRecord[] {
  const rows = idRecords(value)
  for (const row of rows) {
    if (typeof row.type !== "number" || !Number.isSafeInteger(row.type)) invalidResponse()
    if (server && PRIVATE_CHANNEL_TYPES.includes(row.type)) invalidResponse()
    if (row.last_message_id !== undefined && row.last_message_id !== null && !isSnowflake(row.last_message_id))
      invalidResponse()
    if (server ? row.guild_id !== undefined && row.guild_id !== server : row.guild_id != null) invalidResponse()
  }
  return rows
}

/**
 * Validates a newest-first response to a request for the messages after
 * `after`, as `historyPage` does, and requires every id to be above `after`.
 * The page holds the oldest messages after `after`, so it vouches for the ids
 * strictly between `after` and one above its newest; an empty page vouches for
 * nothing, since messages may have arrived since.
 */
export function forwardPage(value: unknown, channel: string, limit: number, after: string): HistoryPage {
  const page = historyPage(value, channel, limit)
  if (page.oldest !== undefined && BigInt(page.oldest) <= BigInt(after)) invalidResponse()
  const before = page.newest === undefined ? after : String(BigInt(page.newest) + 1n)
  return { ...page, range: { after, before } }
}

/** Validates the entire newest-first history response before it can vouch for a deletion range. */
export function historyPage(
  value: unknown,
  channel: string,
  limit: number,
  before?: string,
  observedThrough?: string,
): HistoryPage {
  if (!Array.isArray(value) || value.length > limit) invalidResponse()
  let previous = before === undefined ? undefined : BigInt(before)
  const messages: JsonRecord[] = []
  for (const message of value) {
    if (
      !isRecord(message) ||
      !isSnowflake(message.id) ||
      message.channel_id !== channel ||
      typeof message.content !== "string"
    ) {
      invalidResponse()
    }
    const id = BigInt(message.id)
    if (previous !== undefined && id >= previous) invalidResponse()
    if (message.type !== undefined && (typeof message.type !== "number" || !Number.isSafeInteger(message.type)))
      invalidResponse()
    previous = id
    messages.push(message)
  }
  const newest = messages[0]?.id as string | undefined
  const oldest = messages.at(-1)?.id as string | undefined
  const complete = messages.length < limit
  // Latest pages also vouch for deleted heads observed before dispatch, never for later arrivals.
  const returned = BigInt(newest ?? "0")
  const observed = BigInt(observedThrough ?? "0")
  const upper = before ?? String((returned > observed ? returned : observed) + 1n)
  if (!isSnowflake(upper)) invalidResponse()
  return {
    messages,
    newest,
    oldest,
    complete,
    range: { after: complete ? "0" : String(BigInt(oldest!) - 1n), before: upper },
  }
}
