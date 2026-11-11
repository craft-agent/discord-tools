import { z } from "zod"
import type { ChatSession } from "../chats/session"
import { QUERY_MAX_LENGTH } from "../people/schemas"

/** The methods of `discord_server_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const SERVER_METHODS = ["info", "roles", "emojis", "events", "invites"] as const

/** One method of `discord_server_read`. */
export type ServerMethod = (typeof SERVER_METHODS)[number]

/** How many emojis and stickers `emojis` lists each when `limit` is left out, and the most it lists. */
export const EMOJIS_LIMIT_DEFAULT = 100
export const EMOJIS_LIMIT_MAX = 300

/** How many events `events` lists when `limit` is left out, and the most it lists; the most users of one event it lists is the same. */
export const EVENTS_LIMIT_DEFAULT = 25
export const EVENTS_LIMIT_MAX = 100

/** How many interested users `events` with `event` lists when `limit` is left out. */
export const INTERESTED_LIMIT_DEFAULT = 100

/** How many invites `invites` lists when `limit` is left out, and the most it lists. */
export const INVITES_LIMIT_DEFAULT = 25
export const INVITES_LIMIT_MAX = 100

export const serverReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(SERVER_METHODS)
    .describe(
      "What to read: `info` is what the server says of itself, with its approximate member and online counts; `roles` lists its roles, highest first, with how many members hold each; `emojis` lists its custom emojis and stickers; `events` lists its upcoming and active scheduled events, or with `event` the users interested in one; `invites` lists its invite links. All are read from Discord on every call.",
    ),
  server: z
    .string()
    .describe(
      "The server. Its id, which the local mirror must know (from `discord_chat_read` method `servers`); never a name.",
    ),
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_LENGTH)
    .optional()
    .describe(
      "Method `emojis`: only emojis whose name, and stickers whose name or tags, contain this text, ignoring case. Filters the lists locally.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(EMOJIS_LIMIT_MAX)
    .optional()
    .describe(
      `Methods \`emojis\`, \`events\` and \`invites\`: how many to list at most. \`emojis\`: emojis and stickers each on their own list, 1 to ${EMOJIS_LIMIT_MAX}, default ${EMOJIS_LIMIT_DEFAULT}. \`events\`: events, 1 to ${EVENTS_LIMIT_MAX}, default ${EVENTS_LIMIT_DEFAULT}; with \`event\`, interested users, 1 to ${EVENTS_LIMIT_MAX}, default ${INTERESTED_LIMIT_DEFAULT}. \`invites\`: 1 to ${INVITES_LIMIT_MAX}, default ${INVITES_LIMIT_DEFAULT}.`,
    ),
  event: z
    .string()
    .optional()
    .describe(
      "Method `events`: the id of one scheduled event, to list the users interested in it instead of the server's events.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Method `events` with `event`: a user id; lists the interested users after that one. Pass the `next_after` of the page before.",
    ),
})

/** The arguments of `discord_server_read` after validation. */
export type ServerReadInput = z.output<typeof serverReadInput>

const count = z.number().int().min(0)

const serverItem = z.object({
  id: z.string().describe("The server's id."),
  name: z.string().nullable().describe("The server's name, written by its owners; null when Discord sent none."),
  description: z.string().nullable().describe("The server's description, written by its owners; null when empty."),
  owner: z.string().nullable().describe("The owner's user id; null when Discord sent none."),
  you_own: z.boolean().describe("Whether the user's own account owns the server."),
  created: z.string().describe("When the server was made, as an ISO 8601 UTC time, from its id."),
  members_approx: count.nullable().describe("Discord's approximate member count; null when it gives none."),
  online_approx: count.nullable().describe("Discord's approximate count of members online; null when it gives none."),
  verification_level: z
    .number()
    .int()
    .nullable()
    .describe("The level a member needs to talk: 0 none, 1 low, 2 medium, 3 high, 4 very high; null when not said."),
  nsfw_level: z
    .number()
    .int()
    .nullable()
    .describe("The server's age rating: 0 default, 1 explicit, 2 safe, 3 age restricted; null when not said."),
  explicit_content_filter: z
    .number()
    .int()
    .nullable()
    .describe(
      "Whose media Discord scans for explicit content: 0 nobody, 1 members without roles, 2 every member; null when not said.",
    ),
  premium_tier: z.number().int().nullable().describe("The server's boost level, 0 to 3; null when not said."),
  premium_subscription_count: count.nullable().describe("How many boosts the server has; null when not said."),
  features: z.array(z.string()).describe("Discord's feature flags of the server, such as `COMMUNITY`."),
  preferred_locale: z.string().nullable().describe("The server's preferred language, such as `en-US`."),
  vanity_url_code: z
    .string()
    .nullable()
    .describe("The code of the server's vanity invite link; null when it has none."),
  rules_channel: z.string().nullable().describe("The id of the rules channel; null when none."),
  system_channel: z
    .string()
    .nullable()
    .describe("The id of the channel for Discord's system messages; null when none."),
  icon: z.string().nullable().describe("The hash of the server's icon; null when it has none."),
})

const roleItem = z.object({
  id: z.string().describe("The role's id."),
  name: z.string().nullable().describe("The role's name, written by the server's admins."),
  position: z.number().int().describe("Where the role stands; a higher number is higher."),
  color: z.string().nullable().describe("The role's color as `#rrggbb`; null when it has none."),
  hoist: z.boolean().describe("Whether its members are listed apart from the others."),
  mentionable: z.boolean().describe("Whether anyone may mention the role."),
  managed: z.boolean().describe("Whether an integration, such as a bot or a boost, manages the role."),
  everyone: z.boolean().describe("Whether this is the @everyone role, which every member holds."),
  members: count.nullable().describe("How many members hold the role; null when Discord gives no count."),
  permissions: z.string().nullable().describe("The role's permission bit set, a decimal string as Discord gives it."),
})

const emojiItem = z.object({
  id: z.string().describe("The emoji's id."),
  name: z.string().describe("The emoji's name, written by the server's admins."),
  animated: z.boolean(),
  managed: z.boolean().describe("Whether an integration manages the emoji."),
  available: z.boolean().describe("Whether the emoji can be used; false for one lost with the server's boost level."),
  roles: z.array(z.string()).describe("The ids of the roles allowed to use the emoji; empty when everyone may."),
  use: z
    .string()
    .describe(
      "The text that puts the emoji in a message, `<:name:id>` or `<a:name:id>`; it shows only in a server where the emoji is available to the user.",
    ),
})

const stickerItem = z.object({
  id: z.string().describe("The sticker's id."),
  name: z.string().describe("The sticker's name, written by the server's admins."),
  description: z.string().nullable().describe("The sticker's description; null when empty."),
  tags: z.string().nullable().describe("The sticker's tags, as Discord gives them; null when none."),
  format: z
    .enum(["png", "apng", "lottie", "gif"])
    .nullable()
    .describe("The sticker's file format; null when Discord names none."),
  available: z.boolean().describe("Whether the sticker can be used."),
})

const eventItem = z.object({
  id: z.string().describe("The event's id."),
  name: z.string().nullable().describe("The event's name, written by the people who made it."),
  description: z.string().nullable().describe("The event's description, written by its makers; null when empty."),
  status: z
    .enum(["scheduled", "active", "completed", "canceled"])
    .nullable()
    .describe("Where the event stands; null when Discord names none."),
  kind: z
    .enum(["stage", "voice", "external"])
    .nullable()
    .describe("Where it is held: in a stage channel, a voice channel or somewhere else; null when not said."),
  start: z.string().nullable().describe("When it starts, as an ISO 8601 UTC time; null when not said."),
  end: z.string().nullable().describe("When it ends, as an ISO 8601 UTC time; null when not said."),
  channel: z.string().nullable().describe("The id of the stage or voice channel; null for an external event."),
  location: z.string().nullable().describe("Where an external event is held, written by its makers; null when none."),
  interested: count.nullable().describe("How many users are interested; null when Discord gives no count."),
  creator: z.string().nullable().describe("The id of the user who made the event; null when not said."),
  image: z.string().nullable().describe("The hash of the event's cover image; null when it has none."),
})

const interestedItem = z.object({
  id: z.string().describe("The user's id."),
  name: z.string().describe("The name people see: the nickname in this server, else the display name, else the id."),
  username: z.string().nullable().describe("The user's account name; null when Discord sent none."),
  nick: z.string().nullable().describe("The user's nickname in this server; null when they have none."),
})

const inviteItem = z.object({
  code: z.string().describe("The invite code. Anyone who holds it can join the server: tell it to the user only."),
  url: z.string().describe("The invite link, `https://discord.gg/<code>`; the same warning as the code."),
  channel: z.string().nullable().describe("The id of the channel the invite leads to; null when not said."),
  channel_name: z.string().nullable().describe("That channel's name; null when not said."),
  inviter: z.string().nullable().describe("The id of the user who made the invite; null when not said."),
  inviter_name: z.string().nullable().describe("The inviter's display name; null when not said."),
  uses: count.describe("How many times the invite has been used."),
  max_uses: count.nullable().describe("How many uses it allows; null for unlimited."),
  max_age_s: count.nullable().describe("How many seconds it lasts from when it was made; null for never expires."),
  expires: z.string().nullable().describe("When it expires, as an ISO 8601 UTC time; null when it never does."),
  created: z.string().nullable().describe("When it was made, as an ISO 8601 UTC time; null when not said."),
  temporary: z.boolean().describe("Whether it grants temporary membership: the member is removed on going offline."),
})

export const serverReadOutput = z.object({
  method: z.enum(SERVER_METHODS),
  note: z.string(),
  server: serverItem.optional().describe("Method `info`: what the server says of itself."),
  roles: z
    .array(roleItem)
    .optional()
    .describe("Method `roles`: every role, highest first (by position, then id), @everyone included."),
  count: count
    .optional()
    .describe(
      "Methods `roles`, `events` and `invites`: how many roles, events, interested users or invites are listed.",
    ),
  counts_missing: z
    .boolean()
    .optional()
    .describe("Method `roles`: true when Discord refused the member counts, so every `members` is null."),
  emojis: z
    .array(emojiItem)
    .optional()
    .describe(
      "Method `emojis`: the custom emojis after `query` and `limit`, ordered by name (ignoring case), then id.",
    ),
  stickers: z
    .array(stickerItem)
    .optional()
    .describe(
      "Method `emojis`: the stickers after `query` and `limit`, ordered by name (ignoring case), then id; empty when `stickers_missing`.",
    ),
  emoji_total: count.optional().describe("Method `emojis`: how many emojis match `query`, before `limit`."),
  sticker_total: count.optional().describe("Method `emojis`: how many stickers match `query`, before `limit`."),
  truncated: z
    .object({
      emojis: z.boolean().describe("Whether `limit` cut the emojis."),
      stickers: z.boolean().describe("Whether `limit` cut the stickers."),
    })
    .optional()
    .describe("Method `emojis`: which lists `limit` cut."),
  stickers_missing: z
    .boolean()
    .optional()
    .describe("Method `emojis`: true when Discord refused the sticker list, so `stickers` is empty."),
  events: z
    .array(eventItem)
    .optional()
    .describe(
      "Method `events` without `event`: the server's scheduled and active events, by start time (events without one last), then id.",
    ),
  event: z.string().optional().describe("Method `events` with `event`: the event whose users are listed."),
  interested_users: z
    .array(interestedItem)
    .optional()
    .describe("Method `events` with `event`: the users interested in it, in Discord's order."),
  next_after: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Method `events` with `event`: pass as `after` for the next page of interested users; null when this page was the last.",
    ),
  invites: z
    .array(inviteItem)
    .optional()
    .describe("Method `invites`: the server's invites after `limit`, newest first (by creation time), then code."),
  total: count
    .optional()
    .describe("Methods `events` and `invites`: how many the server has, before `limit` (not for `event`)."),
  list_truncated: z
    .boolean()
    .optional()
    .describe("Methods `events` and `invites`: whether `limit` cut the list (not for `event`)."),
})

/** The result of `discord_server_read`. */
export type ServerReadResult = z.infer<typeof serverReadOutput>

/** The server of an `info` result. */
export type ServerItem = z.infer<typeof serverItem>

/** One role of a `roles` result. */
export type RoleItem = z.infer<typeof roleItem>

/** One emoji of an `emojis` result. */
export type EmojiItem = z.infer<typeof emojiItem>

/** One sticker of an `emojis` result. */
export type StickerItem = z.infer<typeof stickerItem>

/** One event of an `events` result. */
export type EventItem = z.infer<typeof eventItem>

/** One interested user of an `events` result with `event`. */
export type InterestedItem = z.infer<typeof interestedItem>

/** One invite of an `invites` result. */
export type InviteItem = z.infer<typeof inviteItem>

/** What a method returns; the tool adds `method`. */
export type ServerPayload = Omit<ServerReadResult, "method">

/** One method of `discord_server_read`, over an open session. */
export type ServerHandler = (session: ChatSession, args: ServerReadInput) => Promise<ServerPayload>
