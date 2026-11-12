import type { MirroredChannel } from "../chats/channel-target"
import { idTime } from "../chats/format"
import { checkAbort, type ChatSession } from "../chats/session"
import { ingestChannels, ingestMessages } from "../discord/ingest"
import { idTexts, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { isAbortError, isToolError, ToolError } from "../errors"
import { allowedMentions, SUPPRESS_NOTIFICATIONS } from "../sends/payload"
import type { UploadedAttachment } from "../sends/upload"
import { StepErrors } from "../tool"
import { postThread, starterMessage } from "./post-answer"
import { readBackPost } from "./read-back"
import type { PostCreateInput, PostCreateResult } from "./post-schemas"

/** What a result says when the post was created and the mirror stores it. */
export const POST_CREATED_NOTE =
  "The post was created and stored in the local mirror. Its first message has the post's id: reply in it with discord_message_send to the post's id. Other people see its name and text."

/** What a result says when Discord created the post but the mirror did not store it. */
export const POST_UNSTORED_NOTE =
  "The post was created, but the local mirror could not store it (see `errors`); the next sync run picks it up. Its first message has the post's id: reply in it with discord_message_send to the post's id."

/** What an `uncertain` post says: it may exist, `details.read_back` is the look, and nothing was sent again. */
const UNCERTAIN_MESSAGE =
  "The post may have been created, and the request was not sent again. `details.read_back.found` lists the matching posts a read-back saw (empty when it saw none, which does not prove there is none: Discord's thread search can lag), and `failed` or `skipped` means it could not look. Check with discord_chat_read method threads before posting again: a repeat can leave two posts."

/** What a post says: its name, tags and text as given, how its first message notifies, and the files it carries. */
export type PostRequest = Pick<PostCreateInput, "name" | "tags" | "silent" | "mass_mentions"> & {
  text?: string
  attachments?: UploadedAttachment[]
}

/** The request body of a post: its first message is built as a send's is, without a nonce (thread creation takes none). */
export function postBody({ name, tags, text, silent, mass_mentions, attachments }: PostRequest): JsonRecord {
  return {
    name,
    applied_tags: tags ?? [],
    message: {
      ...(text === undefined ? {} : { content: text }),
      flags: silent === true ? SUPPRESS_NOTIFICATIONS : 0,
      allowed_mentions: allowedMentions(mass_mentions === true),
      ...(attachments ? { attachments } : {}),
    },
  }
}

/** Throws `uncertain` after one read-back; it never reports success and never posts again. */
async function failUncertain(
  session: ChatSession,
  name: string,
  forum: MirroredChannel,
  cause?: unknown,
): Promise<never> {
  throw new ToolError("uncertain", UNCERTAIN_MESSAGE, {
    ...(cause instanceof Error ? { cause } : {}),
    details: { read_back: await readBackPost(session, name, forum) },
  })
}

/**
 * Posts in a forum or media channel, once and never retried: a refusal or a
 * connection never made is thrown as it is, anything else, and an answer that
 * is not the new post, is `uncertain` after one read-back. The post Discord
 * returns, with its first message when the answer nests it, is stored without
 * marking any channel current; a failure to store it is reported under
 * `errors`, never thrown.
 */
export async function sendPost(
  session: ChatSession,
  forum: MirroredChannel,
  request: PostRequest,
): Promise<PostCreateResult> {
  checkAbort(session.signal)
  let answer: unknown
  try {
    answer = await session.client().write("POST", `/channels/${forum.target.id}/threads`, {
      body: postBody(request),
      referer: forum.target.referer,
      ...(session.signal ? { signal: session.signal } : {}),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    if (isToolError(error) && error.code !== "uncertain") throw error
    return await failUncertain(session, request.name, forum, error)
  }

  const thread = postThread(answer, forum.target.id)
  if (!thread) return await failUncertain(session, request.name, forum)
  const id = thread.id as string
  const message = starterMessage(answer, id, session.me)
  const steps = new StepErrors()
  await steps.record("store", async () =>
    session.store((stored) => {
      ingestChannels(session.mirror, stored, [thread], forum.server ?? undefined)
      if (message) ingestMessages(session.mirror, stored, [message], { reactions: true })
    }),
  )
  return {
    id,
    channel: forum.target.id,
    server: forum.server,
    name: textOrNull(thread.name) ?? request.name,
    tags: Array.isArray(thread.applied_tags) ? idTexts(thread.applied_tags) : (request.tags ?? []),
    message: id,
    sent_at: idTime(id),
    silent: request.silent ?? false,
    note: steps.any ? POST_UNSTORED_NOTE : POST_CREATED_NOTE,
    ...(steps.any ? { errors: steps.errors } : {}),
  }
}
