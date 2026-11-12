import { z } from "zod"
import { snowflakeId } from "../discord/id-schema"
import { memberItem, roleRef } from "./schemas"

/** How many users one `discord_role_assign` call names at most. */
export const ASSIGN_USERS_MAX = 30

/** The longest audit log `reason`, in UTF-16 units; Discord's own limit. */
export const REASON_MAX = 512

/** The arguments the two role writes share. */
const roleWriteFields = {
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  server: snowflakeId("a server id").describe(
    "The server: its id, which the local mirror must know (from `discord_chat_read` method `servers`); never a name.",
  ),
  role: snowflakeId("a role id").describe(
    "The role: its id from `discord_role_read` method `list`, which must have been read in the last 15 minutes; never a name.",
  ),
  reason: z
    .string()
    .min(1)
    .max(REASON_MAX)
    .refine((reason) => reason.trim() !== "", "must contain a character other than whitespace")
    .optional()
    .describe(
      `Why, up to ${REASON_MAX} characters: sent exactly as given with the change, so the server's audit log shows it, and shown in the approval prompt. Left out, none is sent.`,
    ),
}

export const roleAssignInput = z.object({
  ...roleWriteFields,
  users: z
    .array(snowflakeId("a user id"))
    .min(1)
    .max(ASSIGN_USERS_MAX)
    .refine((users) => new Set(users).size === users.length, "must not name a user twice")
    .describe(
      `The users to give the role to: 1 to ${ASSIGN_USERS_MAX} distinct ids, each a user the local mirror knows (from a chat, a mention, a friend list or \`discord_role_read\` method \`members\`); never names.`,
    ),
})

/** The arguments of `discord_role_assign` after validation. */
export type RoleAssignInput = z.output<typeof roleAssignInput>

export const roleUnassignInput = z.object({
  ...roleWriteFields,
  user: snowflakeId("a user id").describe(
    "The user to take the role from: the id of a user the local mirror knows; never a name.",
  ),
})

/** The arguments of `discord_role_unassign` after validation. */
export type RoleUnassignInput = z.output<typeof roleUnassignInput>

/** What the two role writes need to know of a call besides who it reaches. */
export type RoleWriteInput = Pick<RoleAssignInput, "account" | "server" | "role" | "reason">

export const roleAssignOutput = z.object({
  server: z.string().describe("The server's id."),
  role: roleRef.describe("The role, with the name the stored roles hold."),
  members: z
    .array(memberItem)
    .describe("The users the call named, in the order given, with the names the local mirror holds."),
  given: z
    .boolean()
    .describe("Whether the call gave the role (true) or took it away (false) from the members it names."),
  applied: z
    .array(z.string())
    .optional()
    .describe(
      "Giving a role to several users, when Discord answered with the members it changed: the ids it listed. Absent otherwise, and every member is then as asked.",
    ),
  not_applied: z
    .array(z.string())
    .optional()
    .describe(
      "With `applied`: the ids Discord did not list, such as members who left the server or already held the role.",
    ),
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe("Steps that failed after Discord accepted the change, keyed by step; the change was made all the same."),
})

/** The result of `discord_role_assign` and `discord_role_unassign`. */
export type RoleAssignResult = z.infer<typeof roleAssignOutput>
