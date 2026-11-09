import { isoOrNull } from "../chats/format"
import { openChatSession } from "../chats/session"
import { ingestMessages } from "../discord/ingest"
import { fieldOf, isRecord, timeOrNull, type JsonRecord } from "../discord/ingest-values"
import { ToolError } from "../errors"
import { allowedMentions } from "../sends/payload"
import { StepErrors, type ToolContext } from "../tool"
import type { EditInput, EditResult } from "./schemas"
import { actionTarget, ownMessage } from "./target"
import { failUncertain, runAction } from "./write"

/** What a result says when the new text is on Discord and in the mirror. */
export const EDIT_NOTE = "The message was edited on Discord and the new text is stored in the local mirror."

/** What a result says when Discord took the edit but the mirror did not store it. */
export const EDITED_UNSTORED_NOTE =
  "The message was edited on Discord, but the local mirror could not store the new text (see `errors`); reading the chat live (discord_chat_read method messages) stores it."

/** What an `uncertain` edit says: the edit may have landed, and `details.applied` is the read-back's hint. */
const UNCERTAIN_MESSAGE =
  "The edit may have reached Discord, and it was not sent again. `details.applied` says whether a read-back saw the new text (null when it could not tell). Repeating the same edit is harmless, but ask the user first; discord_chat_read (method messages, live) shows the text as it is now."

/** The message Discord answered an edit with, or `undefined` when the answer is not the edited message: this one, in this chat, by `me`. */
function editedMessage(value: unknown, expected: { id: string; channel: string; me: string }): JsonRecord | undefined {
  if (!isRecord(value) || value.id !== expected.id || value.channel_id !== expected.channel) return undefined
  return fieldOf(value.author, "id") === expected.me ? value : undefined
}

/**
 * Replaces the text of one of the account's own messages. Refused without a
 * request when the mirror does not hold the message, it is not the account's
 * own, or the text is what the mirror already holds. The request is sent once
 * and never retried; an answer that is not the edited message is `uncertain`,
 * as is every failure that may have reached Discord.
 */
export async function editMessage(args: EditInput, ctx: ToolContext): Promise<EditResult> {
  const session = await openChatSession(args, ctx)
  try {
    const target = actionTarget(session, args.channel, args.message)
    ownMessage(target)
    if (args.text === target.message.content) {
      throw new ToolError("invalid_argument", `Message ${args.message} already says this; there is nothing to edit.`)
    }

    const look = (found: JsonRecord | undefined) => found?.content === args.text
    const answer = await runAction(
      session,
      target,
      {
        method: "PATCH",
        path: `/channels/${args.channel}/messages/${args.message}`,
        referer: target.channel.referer,
        body: { content: args.text, allowed_mentions: allowedMentions(args.mass_mentions ?? false) },
      },
      look,
      UNCERTAIN_MESSAGE,
    )
    const edited = editedMessage(answer, { id: args.message, channel: args.channel, me: session.me })
    if (edited === undefined) return await failUncertain(session, target, look, UNCERTAIN_MESSAGE)

    // Discord took the edit: a failure to store it is reported, never thrown.
    const steps = new StepErrors()
    await steps.record("store", async () =>
      session.store((stored) => ingestMessages(session.mirror, stored, [edited], { reactions: false })),
    )
    return {
      id: args.message,
      channel: args.channel,
      edited_at: isoOrNull(timeOrNull(edited.edited_timestamp)),
      note: steps.any ? EDITED_UNSTORED_NOTE : EDIT_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}
