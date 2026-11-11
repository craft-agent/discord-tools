import { invalid } from "../chats/args"
import { parseBounds } from "../chats/bounds"
import { zoneOf } from "./days"
import type { ExportFormat } from "./export-format"
import { EXPORT_FORMAT_DEFAULT, type ExportInput } from "./export-schemas"
import { EXPORT_LIMIT_MAX, type ExportRange } from "./export-select"

/** What an export is asked for, once its arguments are checked: the range to select, the format and the zone to write in. */
export type ExportRequest = { range: ExportRange; format: ExportFormat; zone: string }

/**
 * Refuses what cannot be exported, before anything is opened: a bound that is
 * not an id, a date or a timestamp (or `after` not earlier than `before`), a
 * `time_zone` that is not an IANA zone, and a `limit` over the maximum; and
 * gives the request the arguments make.
 */
export function exportRequest(args: ExportInput): ExportRequest {
  const bounds = parseBounds(args.before, args.after)
  const zone = zoneOf(args.time_zone)
  if (args.limit !== undefined && args.limit > EXPORT_LIMIT_MAX) invalid(`limit is at most ${EXPORT_LIMIT_MAX}.`)
  return {
    range: { chat: args.chat, ...bounds, ...(args.limit === undefined ? {} : { limit: args.limit }) },
    format: args.format ?? EXPORT_FORMAT_DEFAULT,
    zone,
  }
}
