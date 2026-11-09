import { clip } from "../chats/format"
import { openChatSession } from "../chats/session"
import { deleteMessage } from "../discord/ingest"
import { isToolError } from "../errors"
import { confirmWrite, StepErrors, type ToolContext } from "../tool"
import type { DeleteInput, DeleteResult } from "./schemas"
import { actionTarget, ownMessage } from "./target"
import { runAction } from "./write"

/** The tool's identity and class, which the confirmation needs; the spec in `delete-tool.ts` is built from them. */
export const DELETE_TOOL = { id: "discord_message_delete", class: "administrative" } as const

/** Discord's error code for a message it does not have: it was deleted already, or never existed. */
export const UNKNOWN_MESSAGE_CODE = 10008

/** How much of the message the confirmation quotes, in characters. */
const CONFIRM_QUOTE_LENGTH = 100

/** What a result says when Discord deleted the message and the mirror let it go. */
export const DELETE_NOTE =
  "The message was deleted on Discord and removed from the local mirror; it cannot be restored."

/** What a result says when Discord no longer had the message. */
export const DELETE_ALREADY_NOTE =
  "Discord no longer had the message, so nothing was deleted by this call; it was removed from the local mirror."

/** What a result says when the message is gone from Discord but the mirror still holds it. */
export const DELETED_UNSTORED_NOTE =
  "The message is gone from Discord, but the local mirror could not remove it (see `errors`); reading that part of the chat live (discord_chat_read method messages) drops it."

/** What an `uncertain` delete says: the delete may have landed, and `details.applied` is the read-back's hint. */
const UNCERTAIN_MESSAGE =
  "The delete may have reached Discord, and it was not sent again. `details.applied` says whether a read-back found the message gone (null when it could not tell). Deleting it again is harmless, but ask the user first; discord_chat_read (method messages, live) shows the chat as it is now."

/** Whether a refusal says Discord has no such message, which is the state a delete asks for. */
function isUnknownMessage(error: unknown): boolean {
  return isToolError(error) && error.code === "not_found" && error.details?.discord_code === UNKNOWN_MESSAGE_CODE
}

/**
 * Deletes one of the account's own messages after the person confirmed it
 * (where the entry point asks). Refused without a request when the mirror
 * does not hold the message or it is not the account's own. The request is
 * sent once and never retried. A message Discord no longer has is done,
 * marked `already`; anything else that may have reached Discord is `uncertain`.
 */
export async function deleteOwnMessage(args: DeleteInput, ctx: ToolContext): Promise<DeleteResult> {
  const session = await openChatSession(args, ctx)
  try {
    const target = actionTarget(session, args.channel, args.message)
    ownMessage(target)
    const quoted = target.message.content
      ? ` ${JSON.stringify(clip(target.message.content, CONFIRM_QUOTE_LENGTH))}`
      : ""
    await confirmWrite(
      DELETE_TOOL,
      ctx,
      `Delete message ${args.message} in channel ${args.channel}${quoted}? This cannot be undone.`,
    )

    let already = false
    try {
      await runAction(
        session,
        target,
        {
          method: "DELETE",
          path: `/channels/${args.channel}/messages/${args.message}`,
          referer: target.channel.referer,
        },
        (found) => found === undefined,
        UNCERTAIN_MESSAGE,
      )
    } catch (error) {
      if (!isUnknownMessage(error)) throw error
      already = true
    }

    // The message is gone from Discord: a failure to drop it from the mirror is reported, never thrown.
    const steps = new StepErrors()
    await steps.record("store", async () => session.store(() => deleteMessage(session.mirror, args.message)))
    return {
      id: args.message,
      channel: args.channel,
      already,
      note: steps.any ? DELETED_UNSTORED_NOTE : already ? DELETE_ALREADY_NOTE : DELETE_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}
