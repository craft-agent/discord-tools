import { z } from "zod"
import type { ChatSession } from "../chats/session"
import { QUERY_MAX_LENGTH } from "../people/schemas"

/** The methods of `discord_server_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const SERVER_METHODS = ["info", "roles", "emojis"] as const

/** One method of `discord_server_read`. */
export type ServerMethod = (typeof SERVER_METHODS)[number]

/** How many emojis and stickers `emojis` lists each when `limit` is left out, and the most it lists. */
export const EMOJIS_LIMIT_DEFAULT = 100
export const EMOJIS_LIMIT_MAX = 300

export const serverReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(SERVER_METHODS)
    .describe(
      "What to read: `info` is what the server says of itself, with its approximate member and online counts; `roles` lists its roles, highest first, with how many members hold each; `emojis` lists its custom emojis and stickers. All are read from Discord on every call.",
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
      `Method \`emojis\`: how many emojis and how many stickers to list at most, each list on its own, 1 to ${EMOJIS_LIMIT_MAX}. Default ${EMOJIS_LIMIT_DEFAULT}.`,
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

export const serverReadOutput = z.object({
  method: z.enum(SERVER_METHODS),
  note: z.string(),
  server: serverItem.optional().describe("Method `info`: what the server says of itself."),
  roles: z
    .array(roleItem)
    .optional()
    .describe("Method `roles`: every role, highest first (by position, then id), @everyone included."),
  count: count.optional().describe("Method `roles`: how many roles are listed."),
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

/** What a method returns; the tool adds `method`. */
export type ServerPayload = Omit<ServerReadResult, "method">

/** One method of `discord_server_read`, over an open session. */
export type ServerHandler = (session: ChatSession, args: ServerReadInput) => Promise<ServerPayload>
