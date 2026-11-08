import { z } from "zod"
import { isSnowflake } from "../discord/snowflake"

/**
 * The longest `text`, in UTF-16 units. Discord allows 2000 without Nitro and
 * refuses a longer text itself, so this only bounds what is sent to it.
 */
export const SEND_TEXT_MAX = 4000

const id = (what: string) => z.string().refine(isSnowflake, `must be ${what}: a number of up to 20 digits, not a name`)

export const sendInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  channel: id("a channel id").describe(
    "The chat to send to: the id of a DM, group DM, server channel or thread the mirror knows, from discord_chat_read; never a name.",
  ),
  text: z
    .string()
    .min(1)
    .max(SEND_TEXT_MAX)
    .refine((text) => text.trim() !== "", "must contain a character other than whitespace")
    .describe(
      `The message text, sent exactly as given (never trimmed or rewritten), at most ${SEND_TEXT_MAX} characters; Discord itself refuses more than 2000 without Nitro.`,
    ),
  reply_to: id("a message id")
    .optional()
    .describe(
      "The id of a message in this chat, already in the mirror (read the chat first), to reply to. A reply never pings its author.",
    ),
  silent: z
    .boolean()
    .optional()
    .describe("Send without a push or desktop notification for the recipients (default false)."),
  mass_mentions: z
    .boolean()
    .optional()
    .describe(
      "Let `@everyone`, `@here` and role mentions in the text notify (default false: they arrive as plain text without notifying). Mentions of single users always notify.",
    ),
})

/** The arguments of `discord_message_send` after validation. */
export type SendInput = z.output<typeof sendInput>

export const sendOutput = z.object({
  id: z.string().describe("The id of the message that was sent."),
  channel: z.string(),
  sent_at: z.string().describe("When Discord made the message, from its id; ISO 8601 UTC."),
  reply_to: z.string().nullable().describe("The message it replies to, or null."),
  silent: z.boolean(),
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe("Steps that failed after Discord took the message, keyed by step; the message was sent all the same."),
})

/** The result of `discord_message_send`. */
export type SendResult = z.infer<typeof sendOutput>
