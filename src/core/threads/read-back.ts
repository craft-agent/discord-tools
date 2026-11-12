import { THREADS_LIMIT_MAX } from "../chats/args"
import type { MirroredChannel } from "../chats/channel-target"
import { idTime } from "../chats/format"
import type { ChatSession } from "../chats/session"
import { searchThreads } from "../chats/threads-live"
import { idText, textOrNull } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { isToolError } from "../errors"
import type { ThreadCreateInput } from "./schemas"
import { threadObject } from "./thread-object"

/** A thread a read-back saw; `created_at` (from its id) is given for the channel's newest threads. */
export type FoundThread = { id: string; name: string | null; created_at?: string }

/** What a read-back saw: the threads that look like the one asked for, or that it could not look (`failed`) or was cancelled first (`skipped`). */
export type ReadBack = { found: FoundThread[] } | "failed" | "skipped"

/** The thread a message started: it has the message's id, and Discord has none (404) when the message has no thread. */
async function threadOfMessage(session: ChatSession, parent: MirroredChannel, message: string): Promise<FoundThread[]> {
  try {
    const value = await session.client().read("GET", `/channels/${message}`, {
      referer: parent.target.referer,
      ...(session.signal ? { signal: session.signal } : {}),
    })
    const thread = threadObject(value, parent.target.id, message)
    if (!thread) invalidResponse()
    return [{ id: message, name: textOrNull(thread.name) }]
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") return []
    throw error
  }
}

/** The channel's newest active threads that the account owns and that carry exactly `name`, newest first. */
async function ownThreadsNamed(session: ChatSession, parent: MirroredChannel, name: string): Promise<FoundThread[]> {
  const page = await searchThreads(session, {
    channel: parent.target,
    server: parent.server,
    limit: THREADS_LIMIT_MAX,
    offset: 0,
    sort: "created",
    archived: false,
  })
  return page.threads
    .filter((thread) => idText(thread.owner_id) === session.me && thread.name === name)
    .map((thread) => ({
      id: thread.id as string,
      name: textOrNull(thread.name),
      created_at: idTime(thread.id as string),
    }))
}

/**
 * The one look after an uncertain creation, as `find` makes it. A failing look
 * is reported, not thrown, and a cancelled call looks at nothing: the creation
 * is uncertain either way, and it is never sent again.
 */
async function lookAfter(session: ChatSession, find: () => Promise<FoundThread[]>): Promise<ReadBack> {
  if (session.signal?.aborted) return "skipped"
  try {
    return { found: await find() }
  } catch {
    return "failed"
  }
}

/** The look after an uncertain thread: the thread of the message, or the channel's newest threads the account owns with that name. */
export function readBack(
  session: ChatSession,
  { message, name }: Pick<ThreadCreateInput, "message" | "name">,
  parent: MirroredChannel,
): Promise<ReadBack> {
  return lookAfter(session, () =>
    message === undefined ? ownThreadsNamed(session, parent, name) : threadOfMessage(session, parent, message),
  )
}

/** The look after an uncertain post: the forum's newest posts the account owns with that name. */
export function readBackPost(session: ChatSession, name: string, parent: MirroredChannel): Promise<ReadBack> {
  return lookAfter(session, () => ownThreadsNamed(session, parent, name))
}
