import { z } from "zod"

/** The methods of `discord_chat_read`, in the order the schema lists them; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const CHAT_METHODS = ["servers", "channels", "dms"] as const

/** One method of `discord_chat_read`. */
export type ChatMethod = (typeof CHAT_METHODS)[number]

/** The longest `query`, in characters. */
export const QUERY_MAX_LENGTH = 100

/** The largest `offset`; paging deeper than this is a sign of a loop, not a person reading. */
export const OFFSET_MAX = 100_000

export const chatReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(CHAT_METHODS)
    .describe(
      "What to read: `servers` lists the servers the account is in; `channels` lists one server's channels; `dms` lists direct messages and group chats, newest first.",
    ),
  refresh: z
    .boolean()
    .optional()
    .describe("Method `servers`: read the list from Discord even if a recent copy exists."),
  server: z.string().optional().describe("Method `channels`: the server's id, from method `servers`."),
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_LENGTH)
    .optional()
    .describe(
      "Method `dms`: keep only chats whose name or whose people's usernames or display names contain this text.",
    ),
  limit: z.number().int().min(1).optional().describe("Method `dms`: the most chats to return."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(OFFSET_MAX)
    .optional()
    .describe("Method `dms`: how many chats to skip; pass the `next_offset` of the previous result to page."),
})

/** The arguments of `discord_chat_read` after validation. */
export type ChatReadInput = z.output<typeof chatReadInput>

const isoTime = z.string().nullable()

const serverItem = z.object({
  id: z.string(),
  name: z.string().nullable(),
  owner: z.boolean().nullable(),
  followed: z
    .enum(["server", "channels"])
    .nullable()
    .describe("How the sync list follows it: whole, named channels, or not at all."),
})

const channelItem = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.enum(["text", "voice", "announcement", "stage", "forum", "media", "other"]),
  type: z.number().int().describe("Discord's channel type number."),
  category_id: z.string().nullable(),
  category: z.string().nullable(),
  position: z.number().int().nullable(),
  last_message_at: isoTime,
  followed: z
    .boolean()
    .describe(
      "Whether a sync run follows this channel: named in the sync list, or among the most active text channels of a server it follows whole.",
    ),
  current: z.boolean().describe("Whether a sync run marked it current in the last 15 minutes."),
})

const person = z.object({ id: z.string(), name: z.string().nullable() })

const dmItem = z.object({
  id: z.string(),
  kind: z.enum(["dm", "group_dm"]),
  name: z.string().nullable(),
  recipients: z.array(person),
  last_message_at: isoTime,
  last: z
    .object({
      id: z.string(),
      from_me: z.boolean(),
      author_id: z.string().nullable(),
      author: z.string().nullable(),
      at: z.string(),
      text: z.string(),
    })
    .nullable()
    .describe("The newest mirrored message, clipped; null when none is mirrored."),
})

export const chatReadOutput = z.object({
  method: z.enum(CHAT_METHODS),
  source: z.enum(["mirror", "live"]).describe("Whether the list came from the local mirror or from Discord."),
  note: z.string(),
  servers: z.array(serverItem).optional(),
  channels: z.array(channelItem).optional(),
  dms: z.array(dmItem).optional(),
  next_offset: z.number().int().nullable().optional(),
})

/** The result of `discord_chat_read`. */
export type ChatReadResult = z.infer<typeof chatReadOutput>

/** One entry of the `servers` list. */
export type ServerItem = z.infer<typeof serverItem>

/** One entry of the `channels` list. */
export type ChannelItem = z.infer<typeof channelItem>

/** One entry of the `dms` list. */
export type DmItem = z.infer<typeof dmItem>
