import { ingestChannels, ingestMessages } from "../discord/ingest"
import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { isSnowflake } from "../discord/snowflake"
import { channelRecords, invalidResponse } from "../discord/sync-page"
import { THREAD_TYPES } from "./channels"
import type { ChannelTarget } from "./message-page"
import type { ThreadSort } from "./schemas"
import type { ChatSession } from "./session"

/** What a `threads` request asks for. */
export type ThreadSearch = {
  channel: ChannelTarget
  server: string | null
  limit: number
  offset: number
  sort: ThreadSort
  archived?: boolean
  tag?: string
}

/** The threads Discord returned, their first messages and whether more follow. */
export type ThreadPage = { threads: JsonRecord[]; firstMessages: JsonRecord[]; hasMore: boolean }

/** The search order Discord calls each of ours. */
const SORT_BY: Readonly<Record<ThreadSort, string>> = { activity: "last_message_time", created: "creation_time" }

/**
 * Validates a thread search response: an object with at most `limit` threads
 * of `channel` (thread types only), optional first messages that belong to
 * those threads, and an optional boolean `has_more`.
 */
function threadPage(value: unknown, search: ThreadSearch): ThreadPage {
  if (!isRecord(value) || !Array.isArray(value.threads) || value.threads.length > search.limit) invalidResponse()
  if (value.has_more !== undefined && typeof value.has_more !== "boolean") invalidResponse()
  const threads = channelRecords(value.threads, search.server ?? undefined)
  for (const thread of threads) {
    if (thread.parent_id !== search.channel.id || !THREAD_TYPES.includes(thread.type as number)) invalidResponse()
  }
  const ids = new Set(threads.map((thread) => thread.id))
  const firstMessages = value.first_messages ?? []
  if (!Array.isArray(firstMessages)) invalidResponse()
  for (const message of firstMessages) {
    if (
      !isRecord(message) ||
      !isSnowflake(message.id) ||
      typeof message.content !== "string" ||
      !ids.has(message.channel_id)
    ) {
      invalidResponse()
    }
  }
  return { threads, firstMessages: firstMessages as JsonRecord[], hasMore: value.has_more === true }
}

/**
 * Searches a channel's threads on Discord and stores what comes back: the
 * threads as channels and their first messages without their reactions. A page
 * is not contiguous history, so nothing is deleted and nothing is marked current.
 */
export async function searchThreads(session: ChatSession, search: ThreadSearch): Promise<ThreadPage> {
  const value = await session.client().read("GET", `/channels/${search.channel.id}/threads/search`, {
    query: {
      sort_by: SORT_BY[search.sort],
      sort_order: "desc",
      limit: search.limit,
      offset: search.offset,
      archived: search.archived === undefined ? undefined : String(search.archived),
      tag: search.tag,
    },
    referer: search.channel.referer,
    ...(session.signal ? { signal: session.signal } : {}),
  })
  const page = threadPage(value, search)
  session.store((ctx) => {
    ingestChannels(session.mirror, ctx, page.threads, search.server ?? undefined)
    ingestMessages(session.mirror, ctx, page.firstMessages, { reactions: false })
  })
  return page
}
