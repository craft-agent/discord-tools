import { z } from "zod"
import { roleField, roleWriteFields, serverWriteFields } from "./assign-schemas"
import { roleRef } from "./schemas"

/** The longest role `name`, in UTF-16 units; Discord refuses a longer name itself, so this only bounds what is sent to it. */
export const ROLE_NAME_MAX = 100

/** A role name: 1 to `ROLE_NAME_MAX` characters, not whitespace only, and otherwise as given. */
const roleName = z
  .string()
  .min(1)
  .max(ROLE_NAME_MAX)
  .refine((name) => name.trim() !== "", "must contain a character other than whitespace")

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** The word of an edit's `color` that takes the color away. */
export const NO_COLOR = "none"

const roleColor = z.string().regex(COLOR_PATTERN, "must be a color as #rrggbb")

const editColor = z.union([roleColor, z.literal(NO_COLOR)])

/** The permission names of a list argument: distinct, and Discord's names are checked when the call runs. */
const permissionList = z
  .array(z.string())
  .refine((names) => new Set(names).size === names.length, "must not name a permission twice")

export const roleCreateInput = z.object({
  account: serverWriteFields.account,
  server: serverWriteFields.server,
  name: roleName.describe(
    `The new role's name, sent exactly as given (never trimmed or rewritten), at most ${ROLE_NAME_MAX} characters. Everyone in the server sees it.`,
  ),
  permissions: permissionList
    .optional()
    .describe(
      "The permissions the role holds, by Discord's lower-case names (such as `manage_messages`, as `discord_role_read` lists them), each at most once. Left out, none. `administrator`, and any permission the user lacks, is refused.",
    ),
  color: roleColor.optional().describe("The role's color as `#rrggbb`. Left out, none."),
  hoist: z.boolean().optional().describe("List the role's members apart from the others in the member list."),
  mentionable: z.boolean().optional().describe("Let anyone mention the role."),
  reason: serverWriteFields.reason,
})

/** The arguments of `discord_role_create` after validation. */
export type RoleCreateInput = z.output<typeof roleCreateInput>

export const roleEditInput = z.object({
  account: serverWriteFields.account,
  server: serverWriteFields.server,
  role: roleField,
  name: roleName
    .optional()
    .describe(`The role's new name, sent exactly as given, at most ${ROLE_NAME_MAX} characters. Not for @everyone.`),
  color: editColor
    .optional()
    .describe(`The role's new color as \`#rrggbb\`, or \`${NO_COLOR}\` to take its color away. Not for @everyone.`),
  hoist: z.boolean().optional().describe("Whether the role's members are listed apart. Not for @everyone."),
  mentionable: z.boolean().optional().describe("Whether anyone may mention the role. Not for @everyone."),
  grant: permissionList
    .min(1)
    .optional()
    .describe(
      "Permissions to add to the role, by Discord's lower-case names. `administrator`, and any permission the user lacks, is refused. A name must not also be in `revoke`.",
    ),
  revoke: permissionList
    .min(1)
    .optional()
    .describe(
      "Permissions to take away from the role, by Discord's lower-case names; taking one is not limited by what the user holds. A name must not also be in `grant`.",
    ),
  reason: serverWriteFields.reason,
})

/** The arguments of `discord_role_edit` after validation. */
export type RoleEditInput = z.output<typeof roleEditInput>

export const roleDeleteInput = z.object(roleWriteFields)

/** The arguments of `discord_role_delete` after validation. */
export type RoleDeleteInput = z.output<typeof roleDeleteInput>

/** A role with where it stands, as a result names it. */
const placedRole = roleRef.extend({
  position: z.number().int().describe("Where the role stands; a higher number is higher."),
})

const resultTail = {
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe("Steps that failed after Discord accepted the change, keyed by step; the change was made all the same."),
}

export const roleCreateOutput = z.object({
  server: z.string().describe("The server's id."),
  role: placedRole.describe("The role Discord created, as it answered."),
  permissions: z.array(z.string()).describe("Every permission the new role holds, by Discord's name, in bit order."),
  ...resultTail,
})

/** The result of `discord_role_create`. */
export type RoleCreateResult = z.infer<typeof roleCreateOutput>

export const roleEditOutput = z.object({
  server: z.string().describe("The server's id."),
  role: placedRole.describe("The role, as Discord answered."),
  changed: z
    .array(z.string())
    .describe("What the edit changed: `name`, `color`, `hoist`, `mentionable` and `permissions`, those that applied."),
  permissions: z.array(z.string()).describe("Every permission the role holds after the edit, by Discord's name."),
  ...resultTail,
})

/** The result of `discord_role_edit`. */
export type RoleEditResult = z.infer<typeof roleEditOutput>

export const roleDeleteOutput = z.object({
  server: z.string().describe("The server's id."),
  role: roleRef.describe("The role that was deleted, with the name the stored roles held."),
  ...resultTail,
})

/** The result of `discord_role_delete`. */
export type RoleDeleteResult = z.infer<typeof roleDeleteOutput>
