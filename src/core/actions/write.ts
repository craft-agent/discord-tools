import { checkAbort, type ChatSession } from "../chats/session"
import type { RequestOptions } from "../discord/client"
import { ingestMessages } from "../discord/ingest"
import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { isAbortError, isToolError, ToolError } from "../errors"
import type { ActionTarget } from "./target"

/** How many messages around the target the read-back after an uncertain action fetches. */
export const ACTION_READ_BACK_LIMIT = 5

/** Whether a read-back ran: `skipped` when the call was cancelled by then, `failed` when it threw. */
type ReadBackStatus = "done" | "failed" | "skipped"

/** The one request of an action; `referer` is the chat's page. */
export type ActionRequest = {
  method: string
  path: string
  referer: string
  body?: unknown
  query?: RequestOptions["query"]
}

/** Whether the read-back shows the requested state, given the target message in it (`undefined` when it is absent). */
export type Look = (found: JsonRecord | undefined) => boolean

/**
 * The read-back after an uncertain action: the messages around the target,
 * stored in the mirror (never as a range, and nothing is deleted from it: an
 * absent message is only a hint), and whether the target shows the requested
 * state. A failing read-back is reported, not thrown.
 */
async function readBack(
  session: ChatSession,
  { channel, message }: ActionTarget,
  look: Look,
): Promise<{ status: ReadBackStatus; applied: boolean | null }> {
  if (session.signal?.aborted) return { status: "skipped", applied: null }
  try {
    const around = await session.client().read("GET", `/channels/${channel.id}/messages`, {
      query: { around: message.id, limit: ACTION_READ_BACK_LIMIT },
      referer: channel.referer,
      signal: session.signal,
    })
    if (!Array.isArray(around)) return { status: "done", applied: null }
    try {
      session.store((ctx) => ingestMessages(session.mirror, ctx, around, { reactions: true }))
    } catch {
      // What was read stays unstored; `applied` below is still the hint.
    }
    return { status: "done", applied: look(around.filter(isRecord).find((found) => found.id === message.id)) }
  } catch {
    return { status: "failed", applied: null }
  }
}

/**
 * Looks once at the target and throws `uncertain` with `uncertainMessage` and
 * what was seen (`details.applied`, `details.read_back`); it never reports
 * success and never sends the action again. Callers use it for an answer they
 * cannot trust as well as for a request that may have left.
 */
export async function failUncertain(
  session: ChatSession,
  target: ActionTarget,
  look: Look,
  uncertainMessage: string,
  cause?: unknown,
): Promise<never> {
  const seen = await readBack(session, target, look)
  throw new ToolError("uncertain", uncertainMessage, {
    ...(cause instanceof Error ? { cause } : {}),
    details: { applied: seen.applied, read_back: seen.status },
  })
}

/**
 * Sends the one request of an action, once and never retried, and returns
 * Discord's answer. A cancellation, and any refusal or failure known to happen
 * before anything changed, is rethrown as it is for the caller to inspect;
 * anything else is `uncertain` after one read-back (`failUncertain`).
 */
export async function runAction(
  session: ChatSession,
  target: ActionTarget,
  { method, path, referer, body, query }: ActionRequest,
  look: Look,
  uncertainMessage: string,
): Promise<unknown> {
  checkAbort(session.signal)
  try {
    return await session.client().write(method, path, {
      referer,
      ...(body === undefined ? {} : { body }),
      ...(query === undefined ? {} : { query }),
      ...(session.signal ? { signal: session.signal } : {}),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    if (isToolError(error) && error.code !== "uncertain") throw error
    return await failUncertain(session, target, look, uncertainMessage, error)
  }
}
