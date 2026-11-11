import { z } from "zod"
import { actionFields } from "../actions/schemas"
import { snowflakeId } from "../discord/id-schema"

export const readMarkInput = z.object({
  account: actionFields.account,
  channel: snowflakeId("a channel id").describe(
    "The chat to mark read: the id of a DM, group DM, server channel or thread the mirror knows, from discord_chat_read; never a name.",
  ),
  message: snowflakeId("a message id")
    .optional()
    .describe(
      "The id of the message of this chat to mark it read up to; it must be one the mirror holds (read the chat first). Left out, the newest message the mirror holds for the chat.",
    ),
})

/** The arguments of `discord_read_mark` after validation. */
export type ReadMarkInput = z.output<typeof readMarkInput>

export const readMarkOutput = z.object({
  channel: z.string(),
  message: z.string().describe("The id of the message the chat was marked read up to."),
  chat: z.string().describe("The chat as people see it: `#name`, a person's name, a group's name or its id."),
  note: z.string(),
})

/** The result of `discord_read_mark`. */
export type ReadMarkResult = z.infer<typeof readMarkOutput>
