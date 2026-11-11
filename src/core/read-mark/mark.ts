import { describeChat } from "../chats/describe"
import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import { isAbortError, isToolError, ToolError } from "../errors"
import type { ToolContext } from "../tool"
import type { ReadMarkInput, ReadMarkResult } from "./schemas"
import { readMarkTarget, type ReadMarkTarget } from "./target"

/** What a result says when Discord took the mark; the mirror holds no read state, so nothing is stored. */
export const READ_MARKED_NOTE =
  "The chat is marked read on Discord up to this message, on every device the user has. Nothing is stored in the local mirror, which holds no read state."

/** What an `uncertain` mark says: Discord cannot be asked what the read state is, and a second mark changes nothing. */
const UNCERTAIN_MESSAGE =
  "The read mark may have reached Discord, and it was not sent again. Discord offers no way to read the state back (`details.read_back` is `skipped`). Marking the same message again changes nothing further, so it is harmless to repeat, but tell the user first."

/** The details of an `uncertain` mark: no read-back exists to run. */
const NO_READ_BACK = { read_back: "skipped" }

/**
 * Sends the one request of a mark, once and never retried. The body is
 * `{ token: null }` (Discord ignores ack tokens) and never `manual`, so a mark
 * older than the chat's current one leaves the read state where it is. A
 * cancellation, and any refusal or failure known to happen before anything
 * changed, is rethrown as it is; anything else is `uncertain`.
 */
async function sendMark(session: ChatSession, { channel, message }: ReadMarkTarget): Promise<void> {
  checkAbort(session.signal)
  try {
    await session.client().write("POST", `/channels/${channel.id}/messages/${message}/ack`, {
      referer: channel.referer,
      body: { token: null },
      ...(session.signal ? { signal: session.signal } : {}),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    if (isToolError(error) && error.code !== "uncertain") throw error
    throw new ToolError("uncertain", UNCERTAIN_MESSAGE, {
      ...(error instanceof Error ? { cause: error } : {}),
      details: NO_READ_BACK,
    })
  }
}

/**
 * Marks one chat read up to a message the mirror holds, by default the newest.
 * Refused without a request when the mirror does not know the chat, holds no
 * message to mark up to, or does not hold the message named in it. The request
 * is sent once and never retried; every failure that may have reached Discord
 * is `uncertain`. The result names the chat and the message marked, for
 * whatever later keeps read state.
 */
export async function markRead(args: ReadMarkInput, ctx: ToolContext): Promise<ReadMarkResult> {
  const session = await openChatSession(args, ctx)
  try {
    const target = readMarkTarget(session, args.channel, args.message)
    const chat = describeChat(session.mirror, args.channel).name
    await sendMark(session, target)
    return { channel: args.channel, message: target.message, chat, note: READ_MARKED_NOTE }
  } finally {
    session.close()
  }
}
