import { invoke, isToolError, selectTools, type ToolContext, type ToolSpec } from "../core"
import { approvalPrompt, type ShownDescription } from "../entry/description"
import { errorText } from "../entry/errors"
import { ANY_RESOURCE } from "../entry/permission"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import type { RuntimeOptions } from "../entry/runtime"
import { settingsFromOptions } from "../entry/settings"
import type { PluginOptions } from "./types"

/** What a plugin takes from its surroundings; each has a default, and a test supplies its own. */
export type PluginDeps = RuntimeOptions & {
  /** The directory holding `<name>/SKILL.md` files, for the harness version that registers skills. */
  skillsDir?: URL | string
  /** Where the plugin is installed: never a call's working tree. */
  ownDir?: string
}

/** The resources an "always" answer may persist: all but `*`, which would grant every target. */
export function persistableResources(resources: string[]): string[] {
  return resources.filter((resource) => resource !== ANY_RESOURCE)
}

/** What the harness is told about a call it is asked to allow. */
export function permissionMetadata(
  spec: Pick<ToolSpec, "title" | "class">,
  args: unknown,
  resources: string[],
  description?: ShownDescription,
) {
  return {
    arguments: args,
    class: spec.class,
    message: approvalPrompt(spec.title, resources, description),
  }
}

/** Whether a call must be allowed by the harness first: every tool but a read tool. */
export function needsPermission(spec: Pick<ToolSpec, "class">): boolean {
  return spec.class !== "read"
}

/** The tools and resolved state directory the plugin options (and the environment behind them) select from `specs`. */
export function selectedTools(
  specs: ToolSpec[],
  options: PluginOptions | undefined,
  env: Record<string, string | undefined> = process.env,
  profile: EntryProfile = PROJECT_PROFILE,
): { tools: ToolSpec[]; stateDir: string } {
  const settings = settingsFromOptions(options, env, profile)
  return {
    tools: selectTools(specs, settings, profile.toolsets),
    stateDir: settings.state_dir,
  }
}

/**
 * Runs a tool through core `invoke`; a tool failure reaches the harness as an
 * `Error` reading `<code>: <message>`, with `details` as JSON on a line of its
 * own when set.
 */
export async function runTool(spec: ToolSpec, args: unknown, ctx: ToolContext): Promise<unknown> {
  try {
    return await invoke(spec, args, ctx)
  } catch (error) {
    if (!isToolError(error)) throw error
    throw new Error(errorText(error), { cause: error })
  }
}
