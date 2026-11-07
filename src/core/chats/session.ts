import { isAbsolute } from "node:path"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import { createDiscordClient, type DiscordClient } from "../discord/client"
import type { IngestContext } from "../discord/ingest"
import { pickLabel, type LabelPaths } from "../discord/labels"
import { getMeta, inTransaction, openMirrorForIngest, type Mirror } from "../discord/mirror"
import { ACCOUNT_ID_META } from "../discord/mirror-meta"
import { isSnowflake } from "../discord/snowflake"
import { tokenVariable } from "../discord/token"
import type { ToolContext } from "../tool"
import type { ChatReadInput, ChatReadResult } from "./schemas"

/** What a method returns; the tool adds `method` and `note`. */
export type ChatPayload = Omit<ChatReadResult, "method" | "note">

/** One method of `discord_chat_read`, over an open session. */
export type ChatHandler = (session: ChatSession, args: ChatReadInput) => Promise<ChatPayload>

/** One call's view of a label: its mirror, who "me" is, and the one HTTP client, made on first use. */
export type ChatSession = {
  paths: LabelPaths
  mirror: Mirror
  /** The signed-in user's id, from the mirror. */
  me: string
  now(): number
  signal?: AbortSignal
  /** The label's HTTP client; the token is read when the first request is made, never for a read from the mirror. */
  client(): DiscordClient
  /** Runs `fn` in one write transaction with the ingest context of the moment; the only way a tool writes to the mirror. */
  store<T>(fn: (ctx: IngestContext) => T): T
  /** Closes the mirror. */
  close(): void
}

/** Throws the cancellation error when `signal` has aborted. */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * Opens the label the arguments name: `internal_error` without a runtime and
 * an absolute state directory; `not_found` or `invalid_argument` from the label
 * choice; the mirror's own refusals when it is missing or of another version;
 * and `not_found` when the account's sync has not recorded who "me" is.
 */
export async function openChatSession(args: Pick<ChatReadInput, "account">, ctx: ToolContext): Promise<ChatSession> {
  checkAbort(ctx.signal)
  const { runtime, stateDir } = ctx
  if (!runtime || !stateDir || !isAbsolute(stateDir)) {
    throw new ToolError("internal_error", "Chat reads require a runtime and an absolute state directory.")
  }
  const paths = await pickLabel(stateDir, args.account)
  checkAbort(ctx.signal)
  const mirror = openMirrorForIngest(paths.mirror)
  const me = getMeta(mirror)[ACCOUNT_ID_META]
  if (!isSnowflake(me)) {
    mirror.close()
    throw new ToolError("not_found", `The sync of account "${paths.label}" has not run yet, so its user is not known.`)
  }
  let client: DiscordClient | undefined
  return {
    paths,
    mirror,
    me,
    now: runtime.now,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    client() {
      client ??= createDiscordClient({
        stateDir,
        paths,
        tokenVariable: tokenVariable(runtime.envPrefix, paths.label),
        env: runtime.env,
        now: runtime.now,
        ...runtime.discord,
      })
      return client
    },
    store: (fn) => inTransaction(mirror, () => fn({ me, now: runtime.now() })),
    close: () => mirror.close(),
  }
}
