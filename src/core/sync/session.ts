import { isAbsolute } from "node:path"
import { isToolError, ToolError } from "../errors"
import { pickLabel, type LabelPaths } from "../discord/labels"
import { openMirrorForRead, type Mirror } from "../discord/mirror"
import type { ToolContext } from "../tool"
import { checkAbort } from "../chats/session"
import type { SyncReadInput, SyncReadResult } from "./schemas"

/** What a method returns; the tool adds `method` and `note`. */
export type SyncPayload = Omit<SyncReadResult, "method" | "note">

/** One method of `discord_sync_read`, over an open session. */
export type SyncHandler = (session: SyncSession, args: SyncReadInput) => Promise<SyncPayload>

/** One call's view of a label: its sync list's paths and its mirror, when it has one. No HTTP client: this tool never contacts Discord. */
export type SyncSession = {
  paths: LabelPaths
  /** The mirror on a read-only connection; `undefined` before the first sync run has set it up. */
  mirror: Mirror | undefined
  now(): number
  /** Closes the mirror. */
  close(): void
}

/**
 * Opens the label the arguments name: `internal_error` without a runtime and
 * an absolute state directory; `not_found` or `invalid_argument` from the label
 * choice. A mirror that does not exist yet is no error; any other refusal of
 * the mirror propagates.
 */
export async function openSyncSession(args: Pick<SyncReadInput, "account">, ctx: ToolContext): Promise<SyncSession> {
  checkAbort(ctx.signal)
  const { runtime, stateDir } = ctx
  if (!runtime || !stateDir || !isAbsolute(stateDir)) {
    throw new ToolError("internal_error", "Sync reads require a runtime and an absolute state directory.")
  }
  const paths = await pickLabel(stateDir, args.account)
  checkAbort(ctx.signal)
  let mirror: Mirror | undefined
  try {
    mirror = openMirrorForRead(paths.mirror)
  } catch (error) {
    if (!isToolError(error) || error.code !== "not_found") throw error
  }
  return { paths, mirror, now: runtime.now, close: () => mirror?.close() }
}
