import { z } from "zod"
import { MAX_SYNC_CHANNELS } from "../discord/sync-list"
import { isSnowflake } from "../discord/snowflake"
import { MAX_EXCLUDED_CHANNELS } from "./list-edit"
import { followedServer, listLimits, syncReadInput } from "./schemas"

/** A Discord id, as the text of a number. */
export const snowflakeId = z.string().refine(isSnowflake, "must be a Discord id: digits only")

/** A list of ids that names each once. */
export function uniqueIds(max: number) {
  return z
    .array(snowflakeId)
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, "must not repeat an id")
}

/** The `account` argument of the write tools, worded as the read tool words it. */
export const accountField = syncReadInput.shape.account

export const syncAddInput = z.object({
  account: accountField,
  server: snowflakeId.describe("The server's id, from `discord_chat_read` method `servers`."),
  channels: uniqueIds(MAX_SYNC_CHANNELS)
    .optional()
    .describe(
      "Follow only these text or announcement channels of the server (ids, at most 30); they are added to the channels already named. Left out, the whole server is followed: its most active text channels.",
    ),
  exclude: uniqueIds(MAX_EXCLUDED_CHANNELS)
    .optional()
    .describe(
      "Never follow these channels of a whole server (ids, at most 100); they are added to those already excluded. Not with `channels`.",
    ),
})

/** The arguments of `discord_sync_add` after validation. */
export type SyncAddInput = z.output<typeof syncAddInput>

export const syncRemoveInput = z.object({
  account: accountField,
  server: snowflakeId.describe("The server's id, as `discord_sync_read` method `list` shows it."),
  channels: uniqueIds(MAX_SYNC_CHANNELS)
    .optional()
    .describe(
      "Stop following only these channels (ids, at most 30): named channels leave the entry, which goes when none is left; for a whole server they are added to its exclusions. Left out, the server's whole entry goes.",
    ),
})

/** The arguments of `discord_sync_remove` after validation. */
export type SyncRemoveInput = z.output<typeof syncRemoveInput>

/** The result of a write to the sync list: whether it changed, and the list as it stands now. */
export const syncWriteOutput = z.object({
  changed: z.boolean().describe("Whether the sync list changed; false when it already said what was asked."),
  message: z.string().optional().describe("Present when nothing changed because there was nothing to remove."),
  note: z.string(),
  dms: z.literal("always").describe("Direct messages and group chats are always followed."),
  servers: z.array(followedServer).describe("The sync list now, in sync-list order."),
  limits: listLimits.describe("The limits the sync list counts against."),
})

/** The result of `discord_sync_add` and `discord_sync_remove`. */
export type SyncWriteResult = z.infer<typeof syncWriteOutput>
