import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"

/** The objects of Discord's list: an array of objects, else `upstream_error`. */
export function entriesOf(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) invalidResponse()
  return value.map((entry) => (isRecord(entry) ? entry : invalidResponse()))
}
