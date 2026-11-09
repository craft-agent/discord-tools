import { pickLabel } from "../discord/labels"
import type { ToolContext } from "../tool"
import type { ActionInput } from "./schemas"

/** What an action on a message writes to, as the permission rules name it: `<label>/channel/<channel>`. */
export async function actionTargets(args: ActionInput, ctx: ToolContext): Promise<string[]> {
  const { label } = await pickLabel(ctx.stateDir!, args.account)
  return [`${label}/channel/${args.channel}`]
}
