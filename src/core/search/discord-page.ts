import { THREAD_TYPES } from "../chats/channels"
import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { isSnowflake } from "../discord/snowflake"
import { invalidResponse } from "../discord/sync-page"
import type { DiscordScope } from "./scope"

/** What one request of Discord's own search returned, once validated. */
export type DiscordPage = {
  /** The messages that matched, newest first, each once. */
  hits: JsonRecord[]
  /** Discord's estimate of how many messages match in all, when it gave one. */
  total: number | undefined
  /** The threads of a server search, as Discord described them. */
  threads: JsonRecord[]
}

/** The messages of one group: those marked as hits, else the first message (Discord no longer sends context, and `hit` is not required). */
function hitsOfGroup(group: unknown): JsonRecord[] {
  if (!Array.isArray(group)) invalidResponse()
  const messages = group.filter(isRecord)
  const marked = messages.filter((message) => message.hit === true)
  return (marked.length > 0 ? marked : messages.slice(0, 1)).filter((message) => isSnowflake(message.id))
}

/** The threads that are of `server`: an entry of another kind or server would overwrite a channel it does not describe. */
function threadsOf(value: unknown, server: string | undefined): JsonRecord[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalidResponse()
  return value.filter(
    (entry): entry is JsonRecord =>
      isRecord(entry) &&
      isSnowflake(entry.id) &&
      THREAD_TYPES.includes(entry.type as number) &&
      (entry.guild_id == null || entry.guild_id === server),
  )
}

/**
 * Validates an answer of Discord's search: `{ messages, total_results }` for a
 * search of a server or a DM, the same under `tabs.messages` for the search of
 * every DM, with `messages` a list of groups of messages. Anything else is an
 * `upstream_error`; a missing `total_results` is no total. A message that is
 * not an object, has no valid id, repeats an earlier one or is not below
 * `before` is left out, so paging by the oldest hit always moves back.
 */
export function discordPage(value: unknown, scope: DiscordScope, before: string | undefined): DiscordPage {
  const body = scope.kind === "tabs" ? (isRecord(value) && isRecord(value.tabs) ? value.tabs.messages : null) : value
  if (!isRecord(body) || !Array.isArray(body.messages)) invalidResponse()
  const total = body.total_results
  if (total !== undefined && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)) {
    invalidResponse()
  }
  const seen = new Set<string>()
  const hits = body.messages.flatMap(hitsOfGroup).filter((hit) => {
    const id = hit.id as string
    if (seen.has(id) || (before !== undefined && BigInt(id) >= BigInt(before))) return false
    seen.add(id)
    return true
  })
  return { hits, total, threads: scope.kind === "guild" ? threadsOf(body.threads, scope.server) : [] }
}
