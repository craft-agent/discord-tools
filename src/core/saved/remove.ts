import { actionTarget } from "../actions/target"
import { openChatSession } from "../chats/session"
import { isToolError } from "../errors"
import type { ToolContext } from "../tool"
import type { SavedRemoveInput, SavedRemoveResult } from "./schemas"
import { runSavedWrite } from "./write"

/** What a result says when Discord removed the save. */
export const SAVED_REMOVED_NOTE = "The message is no longer saved on Discord, and its reminder, if it had one, is gone."

/** What a result says when Discord did not have the message saved. */
export const SAVED_ALREADY_NOTE = "Discord did not have the message saved, so nothing was removed by this call."

/** What an `uncertain` removal says: it may have landed, and `details.applied` is the read-back's hint. */
const UNCERTAIN_MESSAGE =
  "The removal may have reached Discord, and it was not sent again. `details.applied` says whether a read-back of the saved list found the message gone from it (null when it could not tell). Removing it again is harmless, but ask the user first; discord_inbox_read (method saved) shows the list as it is now."

/**
 * Removes the save or reminder of a message of a chat the mirror knows.
 * Refused without a request when the mirror does not hold the message. The
 * request is sent once and never retried. A message Discord does not have
 * saved (a 404) is done, marked `already`; anything else that may have
 * reached Discord is `uncertain`.
 */
export async function removeSaved(args: SavedRemoveInput, ctx: ToolContext): Promise<SavedRemoveResult> {
  const session = await openChatSession(args, ctx)
  try {
    const target = actionTarget(session, args.channel, args.message)
    let already = false
    try {
      await runSavedWrite(
        session,
        { method: "DELETE", channel: args.channel, message: args.message, referer: target.channel.referer },
        (entry) => entry === undefined,
        UNCERTAIN_MESSAGE,
      )
    } catch (error) {
      if (!(isToolError(error) && error.code === "not_found")) throw error
      already = true
    }
    return {
      channel: args.channel,
      message: args.message,
      already,
      note: already ? SAVED_ALREADY_NOTE : SAVED_REMOVED_NOTE,
    }
  } finally {
    session.close()
  }
}
