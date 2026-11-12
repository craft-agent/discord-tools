import { pickLabel } from "../discord/labels"
import type { ToolContext } from "../tool"
import type { RoleWriteInput } from "./assign-schemas"

/** What a write to a role writes to, as the permission rules name it: `<label>/role/<role>`. */
export async function roleTargets(args: Pick<RoleWriteInput, "account" | "role">, ctx: ToolContext): Promise<string[]> {
  const { label } = await pickLabel(ctx.stateDir!, args.account)
  return [`${label}/role/${args.role}`]
}

/** What the creation of a role writes to, as the permission rules name it: `<label>/server/<server>`. */
export async function serverRoleTargets(
  args: Pick<RoleWriteInput, "account" | "server">,
  ctx: ToolContext,
): Promise<string[]> {
  const { label } = await pickLabel(ctx.stateDir!, args.account)
  return [`${label}/server/${args.server}`]
}
