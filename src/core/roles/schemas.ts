import { z } from "zod"
import type { ChatSession } from "../chats/session"

/** The methods of `discord_role_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const ROLE_METHODS = ["list", "role", "members"] as const

/** One method of `discord_role_read`. */
export type RoleMethod = (typeof ROLE_METHODS)[number]

/** How many member ids Discord returns for a role at most; a result that reaches it may be cut. */
export const ROLE_MEMBERS_CAP = 100

export const roleReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  server: z
    .string()
    .describe(
      "The server. Its id, which the local mirror must know (from `discord_chat_read` method `servers`); never a name.",
    ),
  method: z
    .enum(ROLE_METHODS)
    .describe(
      "What to read: `list` lists the server's roles, highest first, with where the user stands among them; `role` is one role with all its permissions; `members` lists the member ids Discord gives for one role. `list` and `role` also store the snapshot that role writes check against.",
    ),
  role: z
    .string()
    .optional()
    .describe(
      "Methods `role` and `members` (required): the role. Its id, from `list`; never a name. For `members` the role must be in the stored snapshot, and not @everyone (the role whose id is the server's).",
    ),
})

/** The arguments of `discord_role_read` after validation. */
export type RoleReadInput = z.output<typeof roleReadInput>

const count = z.number().int().min(0)

export const roleRef = z.object({
  id: z.string().describe("The role's id."),
  name: z.string().nullable().describe("The role's name, written by the server's admins."),
})

const roleItem = roleRef.extend({
  position: z.number().int().describe("Where the role stands; a higher number is higher."),
  color: z.string().nullable().describe("The role's color as `#rrggbb`; null when it has none."),
  members: count.nullable().describe("How many members hold the role; null when Discord gives no count."),
  hoist: z.boolean().describe("Whether its members are listed apart from the others."),
  mentionable: z.boolean().describe("Whether anyone may mention the role."),
  managed: z.boolean().describe("Whether an integration, such as a bot or a boost, manages the role."),
  everyone: z.boolean().describe("Whether this is the @everyone role, which every member holds."),
  strong: z
    .array(z.string())
    .describe(
      "The role's strong permissions, those that act on other people, the server or its settings, such as `ban_members` or `manage_roles`.",
    ),
  manageable: z
    .boolean()
    .describe(
      "Whether the user may manage this role as the snapshot stands: the user may manage roles, the role is below their highest role (an owner is exempt), it is not managed by an integration and it is not @everyone.",
    ),
})

const roleDetail = roleItem.extend({
  permissions: z.array(z.string()).describe("Every permission the role grants, by Discord's name, in bit order."),
})

const youItem = z.object({
  owner: z.boolean().describe("Whether the user owns the server, as the local mirror's server list says."),
  roles: z
    .array(roleRef)
    .describe("The roles the user holds, highest first, without @everyone (which every member holds)."),
  permissions: z
    .array(z.string())
    .describe(
      "The user's permissions, @everyone's and every held role's joined, by name; all of them for an owner or an administrator.",
    ),
  manage_roles: z.boolean().describe("Whether the user may manage roles: `manage_roles`, `administrator` or owning."),
  highest_position: z.number().int().describe("The position of the user's highest role."),
})

export const memberItem = z.object({
  id: z.string().describe("The member's user id."),
  name: z
    .string()
    .nullable()
    .describe("The name the local mirror holds for the user; null for a user it does not know."),
})

export const roleReadOutput = z.object({
  method: z.enum(ROLE_METHODS),
  note: z.string(),
  server: z.string().describe("The server's id."),
  server_name: z
    .string()
    .nullable()
    .optional()
    .describe("Methods `list` and `role`: the server's name; null when unknown."),
  read_at: z
    .string()
    .optional()
    .describe("Methods `list` and `role`: when the snapshot was read, as an ISO 8601 UTC time."),
  roles: z
    .array(roleItem)
    .optional()
    .describe("Method `list`: every role, highest first (by position, then id), @everyone included."),
  role: z
    .union([roleDetail, roleRef])
    .optional()
    .describe("Method `role`: the role with all its permissions. Method `members`: the role whose members are listed."),
  you: youItem.optional().describe("Methods `list` and `role`: where the user stands in the server."),
  counts_missing: z
    .boolean()
    .optional()
    .describe("Methods `list` and `role`: true when Discord refused the member counts, so every `members` is null."),
  members: z
    .array(memberItem)
    .optional()
    .describe("Method `members`: the member ids Discord gave, with the names the local mirror holds."),
  count: count.optional().describe("Method `members`: how many ids Discord gave."),
  capped: z
    .boolean()
    .optional()
    .describe(
      `Method \`members\`: true when Discord gave ${ROLE_MEMBERS_CAP} ids, the most it gives, so the role may have more members.`,
    ),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Methods `list` and `role`: steps that failed after the roles were read, keyed by step; the read stands.",
    ),
})

/** The result of `discord_role_read`. */
export type RoleReadResult = z.infer<typeof roleReadOutput>

/** One role of a `list` result. */
export type RoleItem = z.infer<typeof roleItem>

/** The role of a `role` result. */
export type RoleDetail = z.infer<typeof roleDetail>

/** The user's standing in a `list` or `role` result. */
export type YouItem = z.infer<typeof youItem>

/** What a method returns; the tool adds `method`. */
export type RolePayload = Omit<RoleReadResult, "method">

/** One method of `discord_role_read`, over an open session. */
export type RoleHandler = (session: ChatSession, args: RoleReadInput) => Promise<RolePayload>
