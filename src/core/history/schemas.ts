import { z } from "zod"
import type { ChatSession } from "../chats/session"
import { WAITING_CHAT_KINDS } from "../inbox/schemas"

/** The methods of `discord_history_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const HISTORY_METHODS = ["counts"] as const

/** One method of `discord_history_read`. */
export type HistoryMethod = (typeof HISTORY_METHODS)[number]

/** What `counts` groups the messages by. */
export const COUNT_GROUPS = ["chat", "author", "day"] as const

/** One way `counts` groups messages. */
export type CountGroup = (typeof COUNT_GROUPS)[number]

export const historyReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(HISTORY_METHODS)
    .describe(
      "What to read: `counts` counts the ordinary messages and replies of the local mirror over a window, per chat, per author or per day. It makes no request to Discord.",
    ),
  by: z
    .enum(COUNT_GROUPS)
    .optional()
    .describe(
      "Method `counts`: what to count per: `chat` (default), `author` or `day`. Totals always cover the whole window, whatever `limit` shows.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Method `counts`: only messages after this: a message id, a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone (a timestamp includes its own instant). Default: 30 days before now.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Method `counts`: only messages before this: a message id, a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone. Default: no end. A `before` older than the default start needs `after` too.",
    ),
  server: z
    .string()
    .optional()
    .describe(
      "Method `counts`: only this server: its id, from `discord_chat_read` method `servers`; never a name. It must be in the local mirror.",
    ),
  chat: z
    .string()
    .optional()
    .describe(
      "Method `counts`: only this chat: its id, from `discord_chat_read` method `dms`, `channels` or `threads`; never a name. It must be in the local mirror.",
    ),
  time_zone: z
    .string()
    .optional()
    .describe(
      "Method `counts`, `by` `day`: the IANA time zone name days are cut in (such as `Asia/Tokyo`), midnight to midnight. Default: this machine's. The result names the zone it used.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Method `counts`: the most rows to return: chats or authors (default 20), or the newest days (default 30); at most 100.",
    ),
})

/** The arguments of `discord_history_read` after validation. */
export type HistoryReadInput = z.output<typeof historyReadInput>

const count = z.number().int().min(0)

export const chatCount = z.object({
  chat: z.object({
    id: z.string(),
    name: z.string().describe("The chat as people see it; its id when the mirror holds no name for it."),
    kind: z.enum(WAITING_CHAT_KINDS),
    server: z.string().nullable().describe("The id of its server; null for a DM or group chat."),
    server_name: z.string().nullable().describe("The server's name; null when the mirror does not know it."),
  }),
  messages: count.describe("How many messages the mirror holds in the window."),
  from_me: count.describe("How many of them the user wrote."),
  people: count.describe("How many different authors wrote them."),
  first: z.string().describe("When the oldest of them was sent, as an ISO 8601 UTC time."),
  last: z.string().describe("When the newest of them was sent, as an ISO 8601 UTC time."),
  partial: z
    .boolean()
    .describe(
      "True when the mirror's history of the chat does not reach back to the window's start, or the mirror holds only scraps of it: the count is a lower bound.",
    ),
  current: z.boolean().describe("Whether a sync run marked the chat current in the last 15 minutes."),
})

const authorCount = z.object({
  author_id: z.string(),
  author: z
    .string()
    .nullable()
    .describe("The server nickname of their latest counted message, else the display name, else the username."),
  messages: count,
  chats: count.describe("In how many different chats they wrote."),
  last: z.string().describe("When their newest counted message was sent, as an ISO 8601 UTC time."),
})

const dayCount = z.object({
  day: z.string().describe("The day, as YYYY-MM-DD in `time_zone`."),
  messages: count,
  from_me: count.describe("How many of them the user wrote."),
})

export const historyReadOutput = z.object({
  method: z.enum(HISTORY_METHODS),
  source: z.literal("mirror").describe("Where the counts came from: the local mirror."),
  note: z.string(),
  by: z.enum(COUNT_GROUPS),
  window_start: z.string().describe("Only messages after this time count, as an ISO 8601 UTC time."),
  window_end: z
    .string()
    .nullable()
    .describe("Only messages before this time count, as an ISO 8601 UTC time; null when the window has no end."),
  time_zone: z.string().describe("The time zone days are cut in; given for every `by`."),
  total: count.describe("All counted messages of the window, whatever `limit` shows."),
  from_me: count.describe("How many of them the user wrote."),
  from_others: count.describe("How many of them others wrote."),
  people: count.describe("How many different authors wrote them."),
  chats: count.describe("In how many different chats."),
  coverage: z
    .object({
      partial: count.describe("How many of those chats are partial: their counts are lower bounds."),
      not_current: count.describe("How many of those chats no sync run marked current in the last 15 minutes."),
    })
    .describe("What the counts may miss, over every chat with counted messages, not only the rows shown."),
  more: z.boolean().describe("True when `limit` cut the rows, so more were found than returned."),
  by_chat: z
    .array(chatCount)
    .optional()
    .describe("`by` `chat`: the chats with the most messages first, then the most recent."),
  by_author: z
    .array(authorCount)
    .optional()
    .describe("`by` `author`: the authors with the most messages first, then the most recent."),
  by_day: z
    .array(dayCount)
    .optional()
    .describe(
      "`by` `day`: the newest days that have messages, the oldest of them first; days without any are left out.",
    ),
})

/** The result of `discord_history_read`. */
export type HistoryReadResult = z.infer<typeof historyReadOutput>

/** One chat of a `by` `chat` result. */
export type ChatCount = z.infer<typeof chatCount>

/** One author of a `by` `author` result. */
export type AuthorCount = z.infer<typeof authorCount>

/** One day of a `by` `day` result. */
export type DayCount = z.infer<typeof dayCount>

/** What a method returns; the tool adds `method`. */
export type HistoryPayload = Omit<HistoryReadResult, "method">

/** One method of `discord_history_read`, over an open session. */
export type HistoryHandler = (session: ChatSession, args: HistoryReadInput) => Promise<HistoryPayload>
