import { z } from "zod"

/** The most `add` suggestions, and the most `remove` suggestions, when `limit` is left out. */
export const SUGGEST_LIMIT_DEFAULT = 10

/** The largest `limit` of method `suggest`. */
export const SUGGEST_LIMIT_MAX = 30

export const namedItem = z.object({ id: z.string(), name: z.string().nullable() })

export const usage = z.object({ used: z.number().int(), max: z.number().int() })

export const addSuggestion = z.object({
  channel: namedItem,
  server: namedItem,
  messages: z.number().int().describe("Messages in the mirror since `since`."),
  from_me: z.number().int().describe("Of those, the account's own."),
  last_message_at: z.string().nullable().describe("The newest of those messages, ISO 8601 UTC."),
  reason: z.string(),
  apply: z.object({
    tool: z.literal("discord_sync_add"),
    args: z.object({ account: z.string(), server: z.string(), channels: z.array(z.string()) }),
  }),
  fits: z.boolean().describe("Whether the list still has room for it after the suggestions above it."),
  why_not: z.string().optional().describe("Why it does not fit; present when `fits` is false."),
})

export const removeSuggestion = z.object({
  server: namedItem,
  channels: z.array(namedItem).nullable().describe("The channels to drop; null drops the whole entry."),
  frees: z.number().int().describe("The channel slots it frees."),
  reason: z.string(),
  apply: z.object({
    tool: z.literal("discord_sync_remove"),
    args: z.object({ account: z.string(), server: z.string(), channels: z.array(z.string()).optional() }),
  }),
})

export const suggestRoom = z.object({ servers: usage, channels: usage })

/** One proposal to add a channel to the sync list. */
export type AddSuggestion = z.infer<typeof addSuggestion>

/** One proposal to remove channels, or a whole entry, from the sync list. */
export type RemoveSuggestion = z.infer<typeof removeSuggestion>

/** The slots the sync list uses now, against its limits. */
export type SuggestRoom = z.infer<typeof suggestRoom>
