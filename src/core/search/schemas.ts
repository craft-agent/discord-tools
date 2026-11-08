import { z } from "zod"
import { messageItem } from "../chats/message-schemas"
import type { ChatSession } from "../chats/session"

/** The methods of `discord_search_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const SEARCH_METHODS = ["mirror"] as const

/** One method of `discord_search_read`. */
export type SearchMethod = (typeof SEARCH_METHODS)[number]

/** What a message can be asked to have, in the order the schema lists them. */
export const SEARCH_HAS = ["link", "file", "image", "video", "sound", "embed", "sticker", "poll"] as const

/** One thing a message can be asked to have. */
export type SearchHas = (typeof SEARCH_HAS)[number]

/** The longest `query`, in characters. */
export const SEARCH_QUERY_MAX_LENGTH = 1024

export const searchReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(SEARCH_METHODS)
    .describe(
      "Where to search: `mirror` searches the messages the local mirror holds, current or not, and makes no request to Discord.",
    ),
  query: z
    .string()
    .min(1)
    .max(SEARCH_QUERY_MAX_LENGTH)
    .optional()
    .describe(
      "The text to look for. Method `mirror`: a literal substring of the message text (nothing in it is special), ignoring case for A–Z only.",
    ),
  channel: z
    .string()
    .optional()
    .describe(
      "Only this chat: its id, from `discord_chat_read` method `dms`, `channels` or `threads`; never a name. Not with `server`. A forum or media channel needs `threads: true`.",
    ),
  server: z
    .string()
    .optional()
    .describe(
      "Only this server's chats: its id, from `discord_chat_read` method `servers`; never a name. Not with `channel`. Left out together with `channel`, everything is searched, DMs included.",
    ),
  author: z.string().optional().describe("Only messages by this user: the user's id."),
  mentions: z.string().optional().describe("Only messages that mention this user: the user's id."),
  has: z
    .array(z.enum(SEARCH_HAS))
    .min(1)
    .optional()
    .describe(
      "Only messages that have all of these, each listed once: `link` (an http:// or https:// address in the text), `file` (any attachment), `image`, `video`, `sound` (an attachment of that kind, by its MIME type), `embed`, `sticker`, `poll`.",
    ),
  pinned: z.boolean().optional().describe("true: only pinned messages; false: only messages that are not pinned."),
  reacted: z
    .boolean()
    .optional()
    .describe(
      "Method `mirror`: true keeps only messages the account has reacted to; false only those it has not. As of the last time each message was read.",
    ),
  emoji: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Method `mirror`: only messages with a reaction of this emoji: the character itself, or `name:id` (also `<:name:id>`) for a custom one.",
    ),
  threads: z
    .boolean()
    .optional()
    .describe(
      "Method `mirror`: with `channel`, true also searches the threads under that channel; for a forum or media channel, its posts.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Only messages before this: a message id, a date (YYYY-MM-DD, UTC) or a timestamp with a zone. Pass the `next_before` of the previous result to page back.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Only messages after this (a timestamp includes its own instant); same forms as `before`; earlier than `before`.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The most messages to return: method `mirror` default 25, at most 100."),
})

/** The arguments of `discord_search_read` after validation. */
export type SearchReadInput = z.output<typeof searchReadInput>

const searchMessageItem = messageItem.extend({
  channel: z.string().describe("The id of the chat the message is in."),
  server: z.string().nullable().describe("The id of its server; null in a DM or group chat."),
})

const searchChatItem = z.object({
  id: z.string(),
  name: z.string().nullable().describe("The chat's name; null for a DM, which is named by its people."),
  server: z.string().nullable().describe("The id of its server; null for a DM or group chat."),
  synced_at: z
    .string()
    .nullable()
    .describe("When a sync run last marked the chat current, as an ISO 8601 UTC time; null when none did."),
  current: z.boolean().describe("Whether a sync run marked it current in the last 15 minutes."),
})

export const searchReadOutput = z.object({
  method: z.enum(SEARCH_METHODS),
  source: z.enum(["mirror"]).describe("Where the messages were searched: the local mirror."),
  note: z.string(),
  messages: z.array(searchMessageItem).describe("Newest first."),
  chats: z
    .array(searchChatItem)
    .describe("The chats the messages are in, in the order they first appear, with how fresh each is."),
  next_before: z
    .string()
    .optional()
    .describe("Present when the page is full: pass as `before` for the next older page."),
  reactions_note: z.string().optional().describe("Present when a message has reactions."),
})

/** The result of `discord_search_read`. */
export type SearchReadResult = z.infer<typeof searchReadOutput>

/** One message of a search result. */
export type SearchMessageItem = z.infer<typeof searchMessageItem>

/** One chat of a search result. */
export type SearchChatItem = z.infer<typeof searchChatItem>

/** What a method returns; the tool adds `method`. */
export type SearchPayload = Omit<SearchReadResult, "method">

/** One method of `discord_search_read`, over an open session. */
export type SearchHandler = (session: ChatSession, args: SearchReadInput) => Promise<SearchPayload>
