import { fieldOf, isRecord, type JsonRecord } from "../discord/ingest-values"
import { PUBLIC_THREAD_TYPE } from "./create"
import { threadObject } from "./thread-object"

/** `value` when it is the public thread of a new post in the forum `forum`, else `undefined`: an answer that is not that says nothing about the post. */
export function postThread(value: unknown, forum: string): JsonRecord | undefined {
  const thread = threadObject(value, forum)
  return thread?.type === PUBLIC_THREAD_TYPE ? thread : undefined
}

/**
 * The first message nested in Discord's answer, when it is the post's own: it
 * has the thread's id, lies in the thread and is by `me`. Anything else is
 * `undefined`, and the post is stored without it.
 */
export function starterMessage(answer: unknown, thread: string, me: string): JsonRecord | undefined {
  const message = fieldOf(answer, "message")
  if (!isRecord(message) || message.id !== thread || message.channel_id !== thread) return undefined
  return fieldOf(message.author, "id") === me ? message : undefined
}
