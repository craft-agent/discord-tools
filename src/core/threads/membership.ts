import { mirroredChannelId, type MirroredChannel } from "../chats/channel-target"
import { CATEGORY_TYPE, THREAD_TYPES } from "../chats/channels"
import { describeChat } from "../chats/describe"
import { DM_TYPE, GROUP_DM_TYPE } from "../chats/dms"
import { channelKind } from "../chats/format"
import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import { isAbortError, isToolError, ToolError } from "../errors"
import type { ToolContext } from "../tool"
import type { ThreadMembershipInput, ThreadMembershipResult } from "./membership-schemas"
import { readBackMembership } from "./read-back"

/** What a result says when the user joined the thread. */
export const THREAD_JOINED_NOTE =
  "The user joined the thread: Discord now sends them its messages and it shows in their thread list. Joining does not reopen an archived thread, and the local mirror holds no membership."

/** What a result says when the user left the thread. */
export const THREAD_LEFT_NOTE =
  "The user left the thread: it no longer shows in their thread list. A private thread may need an invite to rejoin. Leaving does not archive or close the thread, and the local mirror holds no membership."

/** What an `uncertain` join or leave says: it may have landed, `details.read_back` is the look, and nothing was sent again. */
const UNCERTAIN_MESSAGE =
  "The change of the user's membership in the thread may have reached Discord, and it was not sent again. `details.read_back` says whether one look saw the user as a member (`member` true or false), and `failed` or `skipped` means it could not look. Repeating a join is harmless; check the membership (the thread shows in the user's thread list only while they are in it) before leaving again, since a private thread may need an invite to rejoin."

/** The row of a thread the result needs besides what `mirroredChannelId` gives. */
type ParentRow = { parent: string | null }

/** What each kind of channel is called in the refusal. */
const KIND_WORDS: Readonly<Record<ReturnType<typeof channelKind>, string>> = {
  text: "a text channel",
  voice: "a voice channel",
  announcement: "an announcement channel",
  stage: "a stage channel",
  forum: "a forum channel",
  media: "a media channel",
  other: "a channel",
}

/** What a channel that is no thread is, for the refusal. */
function refusedKind(type: number): string {
  if (type === DM_TYPE || type === GROUP_DM_TYPE) return "a DM or group DM"
  if (type === CATEGORY_TYPE) return "a category"
  return KIND_WORDS[channelKind(type)]
}

/**
 * The thread with this id, as the mirror knows it. `not_found` when the mirror
 * has no such channel; `invalid_argument` naming what it is when it is not a
 * public, private or announcement thread (a forum post is a public thread).
 */
function mirroredThread(session: ChatSession, id: string): MirroredChannel {
  const thread = mirroredChannelId(session, id)
  if (!THREAD_TYPES.includes(thread.type)) {
    throw new ToolError(
      "invalid_argument",
      `Channel ${id} is ${refusedKind(thread.type)}, not a thread. Only a thread can be joined or left: use the id of a public, private or announcement thread or of a forum post, which discord_chat_read method threads lists.`,
    )
  }
  return thread
}

/** Throws `uncertain` after one read-back; it never reports success and never sends the change again. */
async function failUncertain(session: ChatSession, thread: MirroredChannel, cause?: unknown): Promise<never> {
  throw new ToolError("uncertain", UNCERTAIN_MESSAGE, {
    ...(cause instanceof Error ? { cause } : {}),
    details: { read_back: await readBackMembership(session, thread) },
  })
}

/**
 * Joins or leaves a thread the mirror knows. Refused without a request when the
 * mirror lacks the channel or it is no thread. The request is sent once and
 * never retried: a refusal or a connection never made is thrown as it is,
 * anything else is `uncertain` after one read of the user's membership.
 * Nothing is written to the mirror, which holds no membership.
 */
async function changeMembership(
  args: ThreadMembershipInput,
  ctx: ToolContext,
  join: boolean,
): Promise<ThreadMembershipResult> {
  const session = await openChatSession(args, ctx)
  try {
    const thread = mirroredThread(session, args.thread)
    const row = session.mirror
      .prepare("SELECT CAST(parent AS TEXT) AS parent FROM channels WHERE id = ?")
      .get(BigInt(args.thread)) as ParentRow | undefined
    const { name } = describeChat(session.mirror, args.thread)
    checkAbort(session.signal)
    try {
      await session.client().write(join ? "PUT" : "DELETE", `/channels/${args.thread}/thread-members/@me`, {
        referer: thread.target.referer,
        ...(session.signal ? { signal: session.signal } : {}),
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isToolError(error) && error.code !== "uncertain") throw error
      return await failUncertain(session, thread, error)
    }
    return {
      thread: args.thread,
      channel: row?.parent ?? null,
      server: thread.server,
      name,
      joined: join,
      note: join ? THREAD_JOINED_NOTE : THREAD_LEFT_NOTE,
    }
  } finally {
    session.close()
  }
}

/** Joins a thread; joining one the user is already in is sent all the same and changes nothing. */
export function joinThread(args: ThreadMembershipInput, ctx: ToolContext): Promise<ThreadMembershipResult> {
  return changeMembership(args, ctx, true)
}

/** Leaves a thread; leaving one the user is not in is sent all the same. */
export function leaveThread(args: ThreadMembershipInput, ctx: ToolContext): Promise<ThreadMembershipResult> {
  return changeMembership(args, ctx, false)
}
