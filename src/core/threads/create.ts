import type { MirroredChannel } from "../chats/channel-target"
import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import { ingestChannels } from "../discord/ingest"
import { intOrNull, isRecord, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { isAbortError, isToolError, ToolError } from "../errors"
import { StepErrors, type ToolContext } from "../tool"
import { checkThreadArgs, threadParent } from "./args"
import { readBack } from "./read-back"
import { THREAD_KIND_BY_TYPE, type ThreadCreateInput, type ThreadCreateResult } from "./schemas"
import { threadObject } from "./thread-object"

/** What a result says when the thread was created and the mirror stores it. */
export const THREAD_CREATED_NOTE =
  "The thread was created and stored in the local mirror. It holds no message unless it was started from one: send the first message with discord_message_send to the thread's id. Other people see its name."

/** What a result says when Discord created the thread but the mirror did not store it. */
export const THREAD_UNSTORED_NOTE =
  "The thread was created, but the local mirror could not store it (see `errors`); the next sync run picks it up. Send the first message with discord_message_send to the thread's id."

/** What an `uncertain` creation says: it may exist, `details.read_back` is the look, and nothing was sent again. */
const UNCERTAIN_MESSAGE =
  "The thread may have been created, and the request was not sent again. `details.read_back.found` lists the matching threads a read-back saw (empty when it saw none, which does not prove there is none: Discord's thread search can lag), and `failed` or `skipped` means it could not look. Check with discord_chat_read method threads before starting another: a repeat can leave two threads."

/** The channel type of a private thread, and of a public one; Discord's default without `type` is private, so it is always sent. */
const PRIVATE_THREAD_TYPE = 12
const PUBLIC_THREAD_TYPE = 11

/** The one request of a creation: the thread of a message, or a standalone thread of the channel. */
function startRequest({ channel, message, name, private: isPrivate, auto_archive }: ThreadCreateInput): {
  path: string
  body: JsonRecord
} {
  const archive = auto_archive === undefined ? {} : { auto_archive_duration: auto_archive }
  if (message !== undefined)
    return { path: `/channels/${channel}/messages/${message}/threads`, body: { name, ...archive } }
  return {
    path: `/channels/${channel}/threads`,
    body: { name, type: isPrivate === true ? PRIVATE_THREAD_TYPE : PUBLIC_THREAD_TYPE, ...archive },
  }
}

/** Throws `uncertain` after one read-back; it never reports success and never starts the thread again. */
async function failUncertain(
  session: ChatSession,
  args: ThreadCreateInput,
  parent: MirroredChannel,
  cause?: unknown,
): Promise<never> {
  throw new ToolError("uncertain", UNCERTAIN_MESSAGE, {
    ...(cause instanceof Error ? { cause } : {}),
    details: { read_back: await readBack(session, args, parent) },
  })
}

/**
 * Starts a thread in a text or announcement channel the mirror knows, from a
 * message the mirror holds there or standalone. Every refusal that can be told
 * from the mirror comes before any request. The request is sent once and never
 * retried: a refusal or a connection never made is thrown as it is, anything
 * else, and an answer that is not the new thread, is `uncertain` after one
 * read-back. The thread Discord returns is stored without marking any channel
 * current; a failure to store it is reported under `errors`, never thrown.
 */
export async function createThread(args: ThreadCreateInput, ctx: ToolContext): Promise<ThreadCreateResult> {
  checkThreadArgs(args)
  const session = await openChatSession(args, ctx)
  try {
    const parent = threadParent(session, args)
    const { path, body } = startRequest(args)
    checkAbort(session.signal)
    let answer: unknown
    try {
      answer = await session.client().write("POST", path, {
        body,
        referer: parent.target.referer,
        ...(session.signal ? { signal: session.signal } : {}),
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isToolError(error) && error.code !== "uncertain") throw error
      return await failUncertain(session, args, parent, error)
    }

    const thread = threadObject(answer, parent.target.id, args.message)
    if (!thread) return await failUncertain(session, args, parent)
    // Discord created the thread: a failure to store it is reported, never thrown.
    const steps = new StepErrors()
    await steps.record("store", async () =>
      session.store((stored) => ingestChannels(session.mirror, stored, [thread], parent.server ?? undefined)),
    )
    const meta = isRecord(thread.thread_metadata) ? thread.thread_metadata : {}
    return {
      id: thread.id as string,
      channel: parent.target.id,
      server: parent.server,
      name: textOrNull(thread.name) ?? args.name,
      type: THREAD_KIND_BY_TYPE[thread.type as number]!,
      from_message: args.message ?? null,
      archives_after: intOrNull(meta.auto_archive_duration),
      note: steps.any ? THREAD_UNSTORED_NOTE : THREAD_CREATED_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}
