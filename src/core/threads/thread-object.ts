import { THREAD_TYPES } from "../chats/channels"
import { idText, isRecord, type JsonRecord } from "../discord/ingest-values"

/**
 * `value` when it is a thread (type 10, 11 or 12) of the channel `parent`, with
 * the id `id` when one is given, else `undefined`: an answer that is not that
 * thread says nothing about it.
 */
export function threadObject(value: unknown, parent: string, id?: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined
  const own = idText(value.id)
  if (own === null || (id !== undefined && own !== id)) return undefined
  if (!THREAD_TYPES.includes(value.type as number) || value.parent_id !== parent) return undefined
  return value
}
