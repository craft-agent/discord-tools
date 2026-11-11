import { fieldOf, idText, isRecord, timeOrNull, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"

/** Where Discord lists the account's saved messages. */
export const SAVED_PATH = "/users/@me/saved-messages"

/** Where Discord keeps the save of one message. */
export const savedPath = (channel: string, message: string) => `${SAVED_PATH}/${channel}/${message}`

/** One save of Discord's list, once validated; times are in milliseconds. */
export type SavedEntry = {
  channel: string
  message: string
  /** The server's id from the save; `null` for none. */
  guild: string | null
  savedAt: number
  /** When the reminder is due; `null` for a save without one. */
  remindAt: number | null
  /** The saved message as the ingest takes it, with its chat and server filled in; `null` when Discord sent none or sent another message. */
  payload: JsonRecord | null
}

/** The message of an entry as the ingest takes it, or `null` when it is absent or is not the saved one. */
function payloadOf(value: unknown, channel: string, message: string, guild: string | null): JsonRecord | null {
  if (!isRecord(value) || idText(value.id) !== message) return null
  if (value.channel_id != null && value.channel_id !== channel) return null
  return {
    ...value,
    channel_id: channel,
    ...(guild !== null && value.guild_id == null ? { guild_id: guild } : {}),
  }
}

/** The entry of one answer, or `undefined` when it lacks a chat, a message, a time it was saved or a reminder time that parses. */
function entryOf(value: unknown): SavedEntry | undefined {
  const save = fieldOf(value, "save_data")
  const channel = idText(fieldOf(save, "channel_id"))
  const message = idText(fieldOf(save, "message_id"))
  const savedAt = timeOrNull(fieldOf(save, "saved_at"))
  const due = fieldOf(save, "due_at")
  const remindAt = due == null ? null : timeOrNull(due)
  if (channel === null || message === null || savedAt === null || (due != null && remindAt === null)) return undefined
  const guild = idText(fieldOf(save, "guild_id"))
  return {
    channel,
    message,
    guild,
    savedAt,
    remindAt,
    payload: payloadOf(fieldOf(value, "message"), channel, message, guild),
  }
}

/**
 * Validates Discord's list of saved messages: an object with a `results` list,
 * else `upstream_error`. An entry that is malformed, or repeats an earlier
 * one, is left out. The order is Discord's.
 */
export function savedEntries(value: unknown): SavedEntry[] {
  const results = fieldOf(value, "results")
  if (!Array.isArray(results)) invalidResponse()
  const seen = new Set<string>()
  return results.flatMap((result) => {
    const entry = entryOf(result)
    if (entry === undefined) return []
    const key = savedPath(entry.channel, entry.message)
    if (seen.has(key)) return []
    seen.add(key)
    return [entry]
  })
}
