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

export function invalidResponse(): never {
  throw new ToolError("upstream_error", "Discord returned an invalid sync response.")
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
