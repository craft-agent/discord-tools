import { z } from "zod"

/** The methods of `discord_sync_read`, in the order the schema lists them; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const SYNC_METHODS = ["list"] as const

/** One method of `discord_sync_read`. */
export type SyncMethod = (typeof SYNC_METHODS)[number]

export const syncReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z.enum(SYNC_METHODS).describe("What to read: `list` shows what the sync service follows."),
})

/** The arguments of `discord_sync_read` after validation. */
export type SyncReadInput = z.output<typeof syncReadInput>

const namedItem = z.object({ id: z.string(), name: z.string().nullable() })

const followedChannel = namedItem.extend({
  current: z.boolean().describe("Whether a sync run marked it current in the last 15 minutes."),
})

const followedServer = z.object({
  id: z.string(),
  name: z.string().nullable().describe("From the local mirror; null when it holds none."),
  follows: z.enum(["server", "channels"]).describe("Whole server (its most active text channels) or named channels."),
  channels: z
    .array(followedChannel)
    .describe(
      "Named channels, in list order; for a whole server, the channels a sync run would pick from the mirrored ones, empty when the mirror holds none.",
    ),
  exclude: z.array(namedItem).describe("Channels the entry never follows."),
  slots: z.number().int().describe("How many of the channel slots the entry uses."),
})

const usage = z.object({ used: z.number().int(), max: z.number().int() })

export const syncReadOutput = z.object({
  method: z.enum(SYNC_METHODS),
  note: z.string(),
  dms: z.literal("always").describe("Direct messages and group chats are always followed."),
  servers: z.array(followedServer).describe("In sync-list order."),
  limits: z.object({
    servers: usage,
    channels: usage,
    whole_server_channels: z.number().int().describe("The channel slots a whole server uses."),
  }),
})

/** The result of `discord_sync_read`. */
export type SyncReadResult = z.infer<typeof syncReadOutput>

/** One server of the `list` result. */
export type FollowedServer = z.infer<typeof followedServer>
