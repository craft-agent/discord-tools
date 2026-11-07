import { ToolError } from "../errors"
import { idText, idTexts, intOrNull, isRecord, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { THREADS_LIMIT_DEFAULT, THREADS_OFFSET_MAX } from "./args"
import { mirroredChannel } from "./channel-target"
import { forumTags } from "./forum-tags"
import { channelKind, displayName, idTime } from "./format"
import type { ChatHandler, ChatSession } from "./session"
import type { TagItem, ThreadItem } from "./thread-schemas"
import { searchThreads } from "./threads-live"

/** The channel types threads are listed under: text, announcement, forum and media. */
const THREAD_PARENT_TYPES: readonly number[] = [0, 5, 15, 16]

/** The channel flag of a post pinned to the top of its forum. */
const THREAD_PINNED_FLAG = 1 << 1

function invalid(message: string): never {
  throw new ToolError("invalid_argument", message)
}

/** The name people see for a user the mirror holds, else `null`. */
function userName(session: ChatSession, id: string | null): string | null {
  if (id === null) return null
  const row = session.mirror.prepare("SELECT username, global_name FROM users WHERE id = ?").get(BigInt(id)) as
    { username: string | null; global_name: string | null } | undefined
  return row ? displayName(row) : null
}

/** A time Discord sent as an ISO 8601 UTC string, or `null` when it is missing or unreadable. */
function isoTime(value: unknown): string | null {
  const text = textOrNull(value)
  const time = text === null ? Number.NaN : Date.parse(text)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

function itemOf(
  session: ChatSession,
  thread: JsonRecord,
  tags: readonly TagItem[],
  first: JsonRecord | undefined,
): ThreadItem {
  const id = thread.id as string
  const meta = isRecord(thread.thread_metadata) ? thread.thread_metadata : {}
  const lastMessage = idText(thread.last_message_id)
  const ownerId = idText(thread.owner_id)
  const authorId = idText(isRecord(first?.author) ? first.author.id : null)
  return {
    id,
    name: textOrNull(thread.name),
    created_at: isoTime(meta.create_timestamp) ?? idTime(id),
    last_message_at: lastMessage === null ? null : idTime(lastMessage),
    archived: meta.archived === true,
    locked: meta.locked === true,
    pinned: ((intOrNull(thread.flags) ?? 0) & THREAD_PINNED_FLAG) !== 0,
    message_count: intOrNull(thread.message_count),
    tags: idTexts(thread.applied_tags).map((tag) => ({
      id: tag,
      name: tags.find((known) => known.id === tag)?.name ?? null,
    })),
    owner_id: ownerId,
    owner: userName(session, ownerId),
    first_post: first
      ? {
          id: first.id as string,
          text: first.content as string,
          author_id: authorId,
          author: userName(session, authorId),
        }
      : null,
  }
}

/**
 * Method `threads`: the threads of a text or announcement channel, or the
 * posts of a forum or media channel, as Discord orders them. Read from Discord
 * and stored: each thread becomes a channel `messages` can read, each first
 * post a message; nothing is deleted and nothing is marked current.
 */
export const readThreads: ChatHandler = async (session, args) => {
  const parent = mirroredChannel(session, args)
  if (!THREAD_PARENT_TYPES.includes(parent.type)) {
    invalid("threads are listed under a text, announcement, forum or media channel.")
  }
  const forum = ["forum", "media"].includes(channelKind(parent.type))
  if (args.tag !== undefined && !forum) invalid("`tag` filters the posts of a forum or media channel only.")
  const tags = forum ? await forumTags(session, parent) : null
  if (args.tag !== undefined && !tags?.some((tag) => tag.id === args.tag)) {
    const valid = tags?.map((tag) => `${tag.id} (${tag.name})`).join(", ")
    invalid(`Tag ${args.tag} is not a tag of this channel; its tags are: ${valid || "none"}.`)
  }

  const limit = args.limit ?? THREADS_LIMIT_DEFAULT
  const offset = args.offset ?? 0
  const page = await searchThreads(session, {
    channel: parent.target,
    server: parent.server,
    limit,
    offset,
    sort: args.sort ?? "activity",
    ...(args.archived === undefined ? {} : { archived: args.archived }),
    ...(args.tag === undefined ? {} : { tag: args.tag }),
  })
  const firstPosts = new Map(page.firstMessages.map((message) => [message.channel_id, message]))
  const next = offset + limit
  return {
    source: "live",
    channel: parent.target.id,
    threads: page.threads.map((thread) => itemOf(session, thread, tags ?? [], firstPosts.get(thread.id))),
    tags,
    next_offset: page.hasMore && next <= THREADS_OFFSET_MAX ? next : null,
  }
}
