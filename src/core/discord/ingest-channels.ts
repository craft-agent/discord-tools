import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import { storeUser } from "./ingest-users"
import {
  fieldOf,
  idOrNull,
  idText,
  idTexts,
  intOrNull,
  isRecord,
  jsonOrNull,
  listOf,
  textOrNull,
  type JsonRecord,
} from "./ingest-values"
import type { Mirror } from "./mirror"
import { upsertChannel, type ChannelRow } from "./mirror-rows"

/** Channel types of threads: announcement, public and private. */
const THREAD_TYPES: readonly number[] = [10, 11, 12]

/** Channel types of forum and media channels, whose posts are threads. */
const FORUM_TYPES: readonly number[] = [15, 16]

/** The channel flag of a post pinned to the top of its forum. */
const THREAD_PINNED_FLAG = 1 << 1

/** A thread's state as JSON (archived, locked, size, times, owner, pinned, applied tags); `null` when the channel is not a thread or has no metadata. */
function threadJson(channel: JsonRecord, type: number): string | null {
  const meta = channel.thread_metadata
  if (!THREAD_TYPES.includes(type) || !isRecord(meta)) return null
  const flags = intOrNull(channel.flags) ?? 0
  return JSON.stringify({
    archived: meta.archived === true,
    locked: meta.locked === true,
    messages: intOrNull(channel.message_count),
    archived_at: textOrNull(meta.archive_timestamp),
    owner: idText(channel.owner_id),
    created: textOrNull(meta.create_timestamp),
    pinned: (flags & THREAD_PINNED_FLAG) !== 0,
    tags: idTexts(channel.applied_tags),
  })
}

/** A forum channel's tags (id, name, emoji) and default sort as JSON; `null` when it is not a forum or the entry has no tag list. */
function forumJson(channel: JsonRecord, type: number): string | null {
  if (!FORUM_TYPES.includes(type) || !Array.isArray(channel.available_tags)) return null
  const tags = channel.available_tags.flatMap((tag) => {
    const id = idText(fieldOf(tag, "id"))
    const name = textOrNull(fieldOf(tag, "name"))
    return id && name ? [{ id, name, emoji: textOrNull(fieldOf(tag, "emoji_name")) }] : []
  })
  return JSON.stringify({ tags, sort: intOrNull(channel.default_sort_order) })
}

/** The channel row of an entry and the recipients it carries, or `null` when it has no valid id or type. */
function channelRow(
  entry: unknown,
  server: string | undefined,
  now: number,
): { row: ChannelRow; recipients: unknown[] } | null {
  if (!isRecord(entry)) return null
  const id = idOrNull(entry.id)
  const type = intOrNull(entry.type)
  if (id === null || type === null) return null
  const recipients = listOf(entry.recipients)
  return {
    recipients,
    row: {
      id,
      server: idOrNull(entry.guild_id) ?? idOrNull(server),
      type,
      name: textOrNull(entry.name),
      parent: idOrNull(entry.parent_id),
      position: intOrNull(entry.position),
      last_message: idOrNull(entry.last_message_id),
      recipients: jsonOrNull(recipients.flatMap((user) => idText(fieldOf(user, "id")) ?? [])),
      thread: threadJson(entry, type),
      forum: forumJson(entry, type),
      raw: JSON.stringify(entry),
      updated: now,
    },
  }
}

/**
 * Stores channels of any kind: DMs and group DMs (their recipients become
 * users and their ids the channel's `recipients`), server channels, threads
 * and forum posts, and forum or media channels. The server is the entry's
 * `guild_id`, else `server`. An entry without `recipients`, `last_message`,
 * `thread` or `forum` keeps the stored value.
 */
export function ingestChannels(mirror: Mirror, ctx: IngestContext, channels: unknown[], server?: string): IngestCounts {
  const counts = newCounts()
  for (const entry of channels) {
    const shaped = channelRow(entry, server, ctx.now)
    if (!shaped) {
      counts.skipped += 1
      continue
    }
    for (const user of shaped.recipients) storeUser(mirror, ctx, user)
    upsertChannel(mirror, shaped.row)
    counts.stored += 1
  }
  return counts
}
