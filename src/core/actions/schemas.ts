import { z } from "zod"
import { snowflakeId } from "../discord/id-schema"

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
