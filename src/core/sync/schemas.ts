import { z } from "zod"
import {
  addSuggestion,
  namedItem,
  removeSuggestion,
  SUGGEST_LIMIT_DEFAULT,
  SUGGEST_LIMIT_MAX,
  suggestRoom,
  usage,
} from "./suggest-schemas"

/** The methods of `discord_sync_read`, in the order the schema lists them; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const SYNC_METHODS = ["list", "suggest"] as const

/** One method of `discord_sync_read`. */
export type SyncMethod = (typeof SYNC_METHODS)[number]

export const syncReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(SYNC_METHODS)
    .describe(
      "What to read: `list` shows what the sync service follows; `suggest` proposes channels to add to the sync list and entries to remove, from the local mirror alone.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Method `suggest`: the window starts after this message id, date (YYYY-MM-DD, UTC midnight) or timestamp with a zone; default 30 days ago.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SUGGEST_LIMIT_MAX)
    .optional()
    .describe(
      `Method \`suggest\` (default ${SUGGEST_LIMIT_DEFAULT}, at most ${SUGGEST_LIMIT_MAX}): the most additions, and the most removals, to propose.`,
    ),
})

/** The arguments of `discord_sync_read` after validation. */
export type SyncReadInput = z.output<typeof syncReadInput>

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

export const syncReadOutput = z.object({
  method: z.enum(SYNC_METHODS),
  note: z.string(),
  dms: z.literal("always").optional().describe("Method `list`: direct messages and group chats are always followed."),
  servers: z.array(followedServer).optional().describe("Method `list`: in sync-list order."),
  limits: z
    .object({
      servers: usage,
      channels: usage,
      whole_server_channels: z.number().int().describe("The channel slots a whole server uses."),
    })
    .optional()
    .describe("Method `list`: the limits the sync list counts against."),
  since: z.string().optional().describe("Method `suggest`: the start of the window, ISO 8601 UTC."),
  add: z
    .array(addSuggestion)
    .optional()
    .describe("Method `suggest`: channels worth following, best first. Nothing changes until a person agrees."),
  remove: z
    .array(removeSuggestion)
    .optional()
    .describe("Method `suggest`: entries or channels that went quiet, in sync-list order."),
  room: suggestRoom.optional().describe("Method `suggest`: the slots used now, before any suggestion."),
})

/** The result of `discord_sync_read`. */
export type SyncReadResult = z.infer<typeof syncReadOutput>

/** One server of the `list` result. */
export type FollowedServer = z.infer<typeof followedServer>
