import { SERVER } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { createAssignFixture } from "./assign.testing"
import { rolePath } from "./manage-plan"
import { discordRoleCreate, discordRoleDelete, discordRoleEdit } from "./manage-tool"
import { roleObject, TIE_A } from "./roles.testing"

/** The id Discord gives the role a test creates, above 2^53. */
export const NEW_ROLE = "1400000000000000840"

/** The bits of `send_messages` and `kick_members`, which the moderator the user holds has through @everyone and its own role. */
export const SEND_MESSAGES = 1n << 11n
export const KICK_MEMBERS = 1n << 1n

/** Discord's answer to a creation: the new role at position 1, as it was asked for. */
export const createdRole = (extra: Record<string, unknown> = {}) =>
  roleObject(NEW_ROLE, 1, { name: "Tea", permissions: "0", ...extra })

/** Discord's answer to an edit of `TIE_A`: the role as it was, with `extra` changed. */
export const editedRole = (extra: Record<string, unknown> = {}) => roleObject(TIE_A, 1, extra)

type ManageFixtureOptions = Parameters<typeof createAssignFixture>[0]

/**
 * The assign fixture with a way to run `discord_role_create`, `discord_role_edit`
 * and `discord_role_delete` as an entry point does. The arguments default to
 * creating the role `Tea` in the made-up server, and to editing or deleting
 * `TIE_A`, the role below the moderator the user holds.
 */
export async function createManageFixture(options?: ManageFixtureOptions) {
  const f = await createAssignFixture(options)
  const target = { server: SERVER, role: TIE_A }
  return {
    ...f,
    create: (args: object = {}, ctx: ToolContext = f.ctx) =>
      invoke(discordRoleCreate, { server: SERVER, name: "Tea", ...args }, ctx),
    edit: (args: object = {}, ctx: ToolContext = f.ctx) => invoke(discordRoleEdit, { ...target, ...args }, ctx),
    remove: (args: object = {}, ctx: ToolContext = f.ctx) => invoke(discordRoleDelete, { ...target, ...args }, ctx),
    /** Makes the fake accept the creation of the role and answer with it. */
    serveCreate: (role: unknown = createdRole()) =>
      f.discord.route("POST", `/guilds/${SERVER}/roles`, { status: 200, json: role }),
    /** Makes the fake accept the edit of `role` and answer with it. */
    serveEdit: (role: unknown = editedRole(), id = TIE_A) =>
      f.discord.route("PATCH", rolePath(SERVER, id), { status: 200, json: role }),
    /** Makes the fake accept the deletion of `role`. */
    serveDelete: (id = TIE_A) => f.discord.route("DELETE", rolePath(SERVER, id), { status: 204 }),
  }
}

export type ManageFixture = Awaited<ReturnType<typeof createManageFixture>>
