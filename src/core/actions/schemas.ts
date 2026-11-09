import { z } from "zod"
import { snowflakeId } from "../discord/id-schema"
import { sendInput } from "../sends/schemas"

/** The arguments every action on a message takes: the account, the chat and the message, the last two by id. */
export const actionFields = {
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  channel: snowflakeId("a channel id").describe(
    "The chat the message is in: the id of a DM, group DM, server channel or thread the mirror knows, from discord_chat_read; never a name.",
  ),
  message: snowflakeId("a message id").describe(
    "The id of a message of this chat that is already in the mirror (read the chat first).",
  ),
}

/** The arguments every action on a message takes, after validation. */
export type ActionInput = z.output<z.ZodObject<typeof actionFields>>

export const editInput = z.object({
  ...actionFields,
  text: sendInput.shape.text.describe(
    "The new message text, replacing the old one and sent exactly as given (never trimmed or rewritten); it must differ from the text the mirror holds.",
  ),
  mass_mentions: z
    .boolean()
    .optional()
    .describe(
      "Let `@everyone`, `@here` and role mentions in the new text notify (default false: they arrive as plain text without notifying).",
    ),
})

/** The arguments of `discord_message_edit` after validation. */
export type EditInput = z.output<typeof editInput>

export const deleteInput = z.object(actionFields)

/** The arguments of `discord_message_delete` after validation. */
export type DeleteInput = z.output<typeof deleteInput>

export const reactionInput = z.object({
  ...actionFields,
  emoji: z
    .string()
    .describe(
      "One Unicode emoji (👍, ❤️, 👍🏽), or a custom emoji that is already on the message as `name:id` (see its reactions in a live read); never a shortcode like `:thumbsup:`.",
    ),
})

/** The arguments of `discord_reaction_add` and `discord_reaction_remove` after validation. */
export type ReactionInput = z.output<typeof reactionInput>

const errorsField = z
  .record(z.string(), z.string())
  .optional()
  .describe("Steps that failed after Discord took the action, keyed by step; the action was done all the same.")

export const editOutput = z.object({
  id: z.string().describe("The id of the message that was edited."),
  channel: z.string(),
  edited_at: z.string().nullable().describe("When Discord says the message was edited; ISO 8601 UTC, or null."),
  note: z.string(),
  errors: errorsField,
})

/** The result of `discord_message_edit`. */
export type EditResult = z.infer<typeof editOutput>

export const deleteOutput = z.object({
  id: z.string().describe("The id of the message that was deleted."),
  channel: z.string(),
  already: z.boolean().describe("True when Discord no longer had the message, so nothing was deleted by this call."),
  note: z.string(),
  errors: errorsField,
})

/** The result of `discord_message_delete`. */
export type DeleteResult = z.infer<typeof deleteOutput>

export const reactionOutput = z.object({
  id: z.string().describe("The id of the message the reaction is on."),
  channel: z.string(),
  emoji: z.string().describe("The emoji as used: the character, or `name:id` for a custom emoji."),
  note: z.string(),
  errors: errorsField,
})

/** The result of `discord_reaction_add` and `discord_reaction_remove`. */
export type ReactionResult = z.infer<typeof reactionOutput>
