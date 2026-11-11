import { z } from "zod"
import { messageItem } from "../chats/message-schemas"
import type { ChatSession } from "../chats/session"

/** The methods of `discord_inbox_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const INBOX_METHODS = ["mentions", "waiting", "saved"] as const

/** One method of `discord_inbox_read`. */
export type InboxMethod = (typeof INBOX_METHODS)[number]

/** Why a chat waits: a DM or group DM, a reply to the user's message, a mention of the user. */
export const WAITING_REASONS = ["dm", "reply", "mention"] as const

/** One reason a chat waits. */
export type WaitingReason = (typeof WAITING_REASONS)[number]

/** The kinds of chat a waiting list names: a DM or group DM, a thread, else the channel's own kind. */
export const WAITING_CHAT_KINDS = [
  "dm",
  "group_dm",
  "thread",
  "text",
  "voice",
  "announcement",
  "stage",
  "forum",
  "media",
  "other",
] as const

/** One kind of chat of a waiting list. */
export type WaitingChatKind = (typeof WAITING_CHAT_KINDS)[number]

export const inboxReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(INBOX_METHODS)
    .describe(
      "What to read: `mentions` is Discord's own list of messages that mention the user, the user's roles, @everyone or @here in the past 7 days, newest first, stored in the local mirror; `waiting` lists the chats whose latest messages the user has not answered, from the local mirror alone; `saved` is the user's own list of saved messages and reminders, from Discord, stored in the local mirror.",
    ),
  server: z
    .string()
    .optional()
    .describe(
      "Only this server: its id, from `discord_chat_read` method `servers`; never a name. Method `mentions` does not need the sync to follow it. Method `waiting` needs a server the account is in.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Method `mentions`: only messages before this message id. Pass the `next_before` of the previous result.",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "Method `waiting`: only messages after this: a message id, a date (YYYY-MM-DD, UTC) or a timestamp with a zone (a timestamp includes its own instant). Default: 14 days before now.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "The most to return: messages for `mentions` (default 25, at most 100), chats for `waiting` (default 30, at most 100), saves for `saved` (default 50, at most 200).",
    ),
})

/** The arguments of `discord_inbox_read` after validation. */
export type InboxReadInput = z.output<typeof inboxReadInput>

const mentionItem = messageItem.extend({
  channel: z.string().describe("The id of the chat the message is in."),
  chat: z
    .string()
    .describe(
      "The chat as people see it: `#name` for a server channel, a thread's name, the other person's name in a DM, a group DM's name or its members; the chat's id when the mirror does not know it.",
    ),
  server: z.string().nullable().describe("The id of its server; null in a DM or group chat, or when not known."),
  server_name: z.string().nullable().describe("The server's name; null when the mirror does not know it."),
})

const waitingChat = z.object({
  chat: z.object({
    id: z.string(),
    name: z.string().describe("The chat as people see it; its id when the mirror holds no name for it."),
    kind: z.enum(WAITING_CHAT_KINDS),
    server: z.string().nullable().describe("The id of its server; null for a DM or group chat."),
    server_name: z.string().nullable().describe("The server's name; null when the mirror does not know it."),
  }),
  why: z
    .array(z.enum(WAITING_REASONS))
    .describe(
      "`dm`: a DM or group DM, where every message from others since the user's last counts; `reply`: a message replying to one of the user's; `mention`: a message mentioning the user by id (not @everyone, not a role).",
    ),
  waiting: z.number().int().min(1).describe("How many messages from others have not been answered."),
  since: z.string().describe("When the oldest of them was sent, as an ISO 8601 UTC time."),
  latest: z.object({
    id: z.string(),
    at: z.string().describe("When it was sent, as an ISO 8601 UTC time."),
    author_id: z.string().nullable(),
    author: z.string().nullable().describe("The server nickname, else the display name, else the username."),
    text: z.string().describe("The message text, clipped."),
  }),
  current: z.boolean().describe("Whether a sync run marked the chat current in the last 15 minutes."),
})

const savedItem = z.object({
  channel: z.string().describe("The id of the chat the saved message is in."),
  chat: z
    .string()
    .describe(
      "The chat as people see it: `#name` for a server channel, a thread's name, the other person's name in a DM, a group DM's name or its members; the chat's id when the mirror does not know it.",
    ),
  server: z.string().nullable().describe("The id of its server; null in a DM or group chat, or when not known."),
  server_name: z.string().nullable().describe("The server's name; null when the mirror does not know it."),
  message_id: z.string().describe("The id of the saved message."),
  saved_at: z.string().describe("When the message was saved, as an ISO 8601 UTC time."),
  remind_at: z
    .string()
    .nullable()
    .describe("When the reminder is due, as an ISO 8601 UTC time; null for a save without one."),
  due: z.boolean().describe("Whether the reminder's time has passed; false for a save without a reminder."),
  message: messageItem
    .nullable()
    .describe("The saved message; null when Discord sent none (deleted, or the account cannot see it any more)."),
})

export const inboxReadOutput = z.object({
  method: z.enum(INBOX_METHODS),
  source: z.enum(["discord", "mirror"]).describe("Where the list came from: Discord, or the local mirror."),
  note: z.string(),
  messages: z.array(mentionItem).optional().describe("Method `mentions`: newest first."),
  next_before: z
    .string()
    .optional()
    .describe("Method `mentions`: pass as `before` for the next older page; present when the page was full."),
  reactions_note: z
    .string()
    .optional()
    .describe("Methods `mentions` and `saved`: present when a message has reactions."),
  saved: z
    .array(savedItem)
    .optional()
    .describe(
      "Method `saved`: the user's saves, reminders first by their time (the earliest first), then saves without a reminder, the newest first.",
    ),
  chats: z
    .array(waitingChat)
    .optional()
    .describe("Method `waiting`: the chats that wait for the user's answer, the one with the newest message first."),
  total: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Methods `waiting` and `saved`: how many chats wait, or how many messages are saved, in all."),
  more: z
    .boolean()
    .optional()
    .describe("Methods `waiting` and `saved`: true when `limit` cut the list, so more were found than returned."),
  window_start: z
    .string()
    .optional()
    .describe("Method `waiting`: only messages after this time count, as an ISO 8601 UTC time."),
  last_sync_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Method `waiting`: when the last complete sync run finished, as an ISO 8601 UTC time; null when none has.",
    ),
})

/** The result of `discord_inbox_read`. */
export type InboxReadResult = z.infer<typeof inboxReadOutput>

/** One message of a `mentions` result. */
export type MentionItem = z.infer<typeof mentionItem>

/** One chat of a `waiting` result. */
export type WaitingChat = z.infer<typeof waitingChat>

/** One save of a `saved` result. */
export type SavedItem = z.infer<typeof savedItem>

/** What a method returns; the tool adds `method`. */
export type InboxPayload = Omit<InboxReadResult, "method">

/** One method of `discord_inbox_read`, over an open session. */
export type InboxHandler = (session: ChatSession, args: InboxReadInput) => Promise<InboxPayload>
