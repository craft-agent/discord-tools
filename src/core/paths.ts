import { realpath } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import type { ToolContext } from "./tool"

/** Whether `dir` is `root` or inside it, compared by real path; a path that cannot be resolved is not. */
export async function isWithin(dir: string, root: string): Promise<boolean> {
  try {
    const path = relative(await realpath(root), await realpath(dir))
    return path === "" || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  } catch {
    return false
  }
}

/** One of the tools' own directories, with the words that name it in a message. */
export type PrivateDir = { root: string; what: string }

/**
 * The state directory or the tools' install directory when `dir` is, holds or
 * sits inside it, compared by real path both ways; `undefined` when it
 * overlaps neither (or the context names neither).
 */
export async function overlapsPrivate(
  dir: string,
  ctx: Pick<ToolContext, "stateDir" | "ownDir">,
): Promise<PrivateDir | undefined> {
  for (const [root, what] of [
    [ctx.stateDir, "the state directory"],
    [ctx.ownDir, "the tools' install directory"],
  ] as const) {
    if (root !== undefined && ((await isWithin(dir, root)) || (await isWithin(root, dir)))) return { root, what }
  }
  return undefined
}
