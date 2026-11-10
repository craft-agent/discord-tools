import { join } from "node:path"
import type { ToolContext } from "../tool"
import { downloadSettings } from "./download-dir"
import type { SaveInput } from "./schemas"

/** What a save writes to: the message's folder, `<download_dir>/<channel>-<message>`. */
export function saveTargets(args: SaveInput, ctx: ToolContext): string[] {
  return [join(downloadSettings(ctx).dir, `${args.channel}-${args.message}`)]
}
