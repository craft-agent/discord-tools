import type { ChatSession } from "../chats/session"
import type { IngestContext } from "../discord/ingest-context"
import { isAbortError, isToolError, type JsonValue, ToolError } from "../errors"
import type { StepErrors } from "../tool"
import { serverReferer } from "./assign-read-back"

/** The request of a role write: where it goes and what it carries. */
export type RoleRequest = { method: string; path: string; body?: unknown }

/** What sending a role write came to: Discord's answer, or that the outcome is unknown (with the failure that said so). */
export type SentRoleWrite = { kind: "answered"; answer: unknown } | { kind: "unclear"; cause?: Error }

/**
 * Sends a role write once, from the server's page, with the audit log
 * `reason` when there is one, and never retries it. A refusal or a connection
 * never made is thrown as it is, as is a cancellation; anything else leaves the
 * outcome `unclear`.
 */
export async function sendRoleWrite(
  session: ChatSession,
  server: string,
  reason: string | undefined,
  { method, path, body }: RoleRequest,
): Promise<SentRoleWrite> {
  try {
    const answer = await session.client().write(method, path, {
      referer: serverReferer(server),
      ...(body === undefined ? {} : { body }),
      ...(reason === undefined ? {} : { reason }),
      ...(session.signal ? { signal: session.signal } : {}),
    })
    return { kind: "answered", answer }
  } catch (error) {
    if (isAbortError(error)) throw error
    if (isToolError(error) && error.code !== "uncertain") throw error
    return { kind: "unclear", ...(error instanceof Error ? { cause: error } : {}) }
  }
}

/** The `uncertain` error of a role write that may have reached Discord: `readBack` is the one look that followed. */
export function uncertainRoleWrite(message: string, readBack: JsonValue, cause?: Error): ToolError {
  return new ToolError("uncertain", message, { ...(cause ? { cause } : {}), details: { read_back: readBack } })
}

/**
 * Changes the stored snapshot through the ingest. A failure to store is
 * recorded in `steps` and never hides the outcome of the write.
 */
export function storeInSnapshot(
  session: ChatSession,
  steps: StepErrors,
  change: (ctx: IngestContext) => unknown,
): Promise<void> {
  return steps.record("snapshot", async () => session.store(change)).then(() => undefined)
}
