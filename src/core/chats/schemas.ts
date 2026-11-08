import { z } from "zod"
import { messageItem } from "./message-schemas"
import { pinItem, tagItem, threadItem } from "./thread-schemas"

/** The methods of `discord_chat_read`, in the order the schema lists them; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const CHAT_METHODS = ["servers", "channels", "dms", "messages", "around", "threads", "pins", "backfill"] as const

/** The orders `threads` lists by, `activity` being the default. */
export const THREAD_SORTS = ["activity", "created"] as const

/** One order of the `threads` list. */
export type ThreadSort = (typeof THREAD_SORTS)[number]

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
      "What to read: `servers` lists the servers the account is in; `channels` lists one server's channels; `dms` lists direct messages and group chats, newest first; `messages` reads one chat's messages, oldest first; `around` reads the messages around one message; `threads` lists the threads of a text or announcement channel or the posts of a forum or media channel; `pins` lists a chat's pinned messages, newest pin first; `backfill` pulls older history of a chat the sync follows into the local mirror.",
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
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Methods `dms` (default 30, at most 200), `messages` (default 50, at most 100), `threads` (default 25, at most 25) and `pins` (default 50, at most 50): the most to return.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(OFFSET_MAX)
    .optional()
    .describe(
      "Methods `dms` and `threads` (at most 9975): how many to skip; pass the `next_offset` of the previous result to page.",
    ),
  channel: z
    .string()
    .optional()
    .describe(
      "Methods `messages`, `around`, `threads`, `pins` and `backfill`: the chat's id, from method `dms`, `channels` or `threads`; never a name. `threads` takes a text, announcement, forum or media channel; `backfill` takes a chat the sync follows.",
    ),
  pages: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Method `backfill`: how many pages of 100 older messages to pull (default 2, at most 5)."),
  archived: z
    .boolean()
    .optional()
    .describe("Method `threads`: true lists only archived threads, false only active ones; left out, both."),
  sort: z
    .enum(THREAD_SORTS)
    .optional()
    .describe(
      "Method `threads`: `activity` (default) orders by the latest message, `created` by creation; newest first.",
    ),
  tag: z
    .string()
    .optional()
    .describe(
      "Method `threads`: only posts with this tag, a tag id from the `tags` of a forum or media channel's result.",
    ),
  message: z.string().optional().describe("Method `around`: the id of the message to read around."),
  before: z
    .string()
    .optional()
    .describe(
      "Method `messages`: only messages before this: a message id, a date (YYYY-MM-DD, UTC) or a timestamp with a zone. Method `pins`: only pins made before this date or timestamp, never a message id. Pass the `next_before` of the previous result to page back.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Method `messages`: only messages after this (a timestamp includes its own instant); same forms as `before`. Alone, it reads forward from there, oldest first; pass the `next_after` of the previous result to page on.",
    ),
  live: z.boolean().optional().describe("Method `messages`: read from Discord even if the mirror could answer."),
  before_count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Method `around`: how many older messages to return (default 5, at most 50)."),
  after_count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Method `around`: how many newer messages to return (default 5, at most 50)."),
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
  channel: z.string().optional().describe("Methods `messages`, `around`, `threads` and `pins`: the chat read."),
  threads: z
    .array(threadItem)
    .optional()
    .describe("As Discord ordered them; not contiguous, so a page may skip threads."),
  tags: z
    .array(tagItem)
    .nullable()
    .optional()
    .describe("Method `threads`: the tags the forum or media channel offers; null for any other channel."),
  pins: z.array(pinItem).optional().describe("Newest pin first."),
  message: z.string().optional().describe("Method `around`: the message the result is centred on."),
  messages: z.array(messageItem).optional().describe("Oldest first."),
  next_before: z
    .string()
    .nullable()
    .optional()
    .describe("Methods `messages` and `pins`: pass as `before` for the next older page; null when none."),
  next_after: z
    .string()
    .nullable()
    .optional()
    .describe("Method `messages` reading forward: pass as `after` for the next newer page; null when none."),
  reactions_note: z.string().optional().describe("Present when a message has reactions."),
  pages: z.number().int().optional().describe("Method `backfill`: how many pages were requested from Discord."),
  stored: z.number().int().optional().describe("Method `backfill`: how many messages were stored."),
  deleted: z
    .number()
    .int()
    .optional()
    .describe("Method `backfill`: how many mirrored messages Discord no longer has, removed."),
  complete: z
    .boolean()
    .optional()
    .describe(
      "Method `backfill`: whether the mirror now reaches the chat's first message; stays false when Discord returned no older messages, which happens both before a history's start and when the account cannot read the history.",
    ),
  oldest: z
    .string()
    .nullable()
    .optional()
    .describe("Method `backfill`: the id of the oldest message the mirror holds."),
  oldest_at: isoTime.optional().describe("Method `backfill`: the time of that message."),
  stopped: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .optional()
    .describe("Method `backfill`: why paging stopped early; null when it did not. What was stored stays stored."),
})

/** The result of `discord_chat_read`. */
export type ChatReadResult = z.infer<typeof chatReadOutput>

/** One entry of the `servers` list. */
export type ServerItem = z.infer<typeof serverItem>

/** One entry of the `channels` list. */
export type ChannelItem = z.infer<typeof channelItem>

/** One entry of the `dms` list. */
export type DmItem = z.infer<typeof dmItem>
