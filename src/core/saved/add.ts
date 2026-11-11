import { actionTarget } from "../actions/target"
import { isoOrNull } from "../chats/format"
import { openChatSession } from "../chats/session"
import { fieldOf, timeOrNull } from "../discord/ingest-values"
import type { ToolContext } from "../tool"
import { remindTime, requireFuture } from "./remind"
import type { SavedAddInput, SavedAddResult } from "./schemas"
import { runSavedWrite } from "./write"

/** What a result says when Discord saved the message. */
export const SAVED_ADDED_NOTE =
  "The message is saved on Discord, in the user's own list (discord_inbox_read method saved). A reminder is Discord's own mark on the save, not a notification this tool sends; saving the message again replaces it."

/** What an `uncertain` save says: the save may have landed, and `details.applied` is the read-back's hint. */
const UNCERTAIN_MESSAGE =
  "The save may have reached Discord, and it was not sent again. `details.applied` says whether a read-back of the saved list found the message saved with the reminder asked for (null when it could not tell). Saving it again is harmless, but ask the user first; discord_inbox_read (method saved) shows the list as it is now."

/**
 * Saves a message of a chat the mirror knows, whoever wrote it, with an
 * optional reminder, replacing the reminder of a save it already has. Refused
 * without a request when the mirror does not hold the message or `remind_at`
 * is not a timestamp with a zone later than now. The request is sent once and
 * never retried; every failure that may have reached Discord is `uncertain`.
 */
export async function addSaved(args: SavedAddInput, ctx: ToolContext): Promise<SavedAddResult> {
  const remindAt = args.remind_at === undefined ? null : remindTime(args.remind_at)
  const session = await openChatSession(args, ctx)
  try {
    if (remindAt !== null) requireFuture(remindAt, session.now())
    const target = actionTarget(session, args.channel, args.message)
    const asked = remindAt === null ? null : Date.parse(remindAt)
    const answer = await runSavedWrite(
      session,
      {
        method: "PUT",
        channel: args.channel,
        message: args.message,
        referer: target.channel.referer,
        body: { due_at: remindAt },
      },
      (entry) => entry !== undefined && entry.remindAt === asked,
      UNCERTAIN_MESSAGE,
    )
    const save = fieldOf(answer, "save_data")
    return {
      channel: args.channel,
      message: args.message,
      saved_at: isoOrNull(timeOrNull(fieldOf(save, "saved_at"))),
      remind_at: isoOrNull(timeOrNull(fieldOf(save, "due_at"))),
      note: SAVED_ADDED_NOTE,
    }
  } finally {
    session.close()
  }
}
