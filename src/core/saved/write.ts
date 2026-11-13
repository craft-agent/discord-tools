import { checkAbort, type ChatSession } from "../chats/session"
import { isAbortError, isToolError, ToolError } from "../errors"
import { readSavedList, savedEntries, savedPath, type SavedEntry } from "./entries"

/** The one request of a change to the saved list; `referer` is the chat's page. */
export type SavedRequest = {
  method: "PUT" | "DELETE"
  channel: string
  message: string
  referer: string
  body?: unknown
}

/** Whether the read-back shows the requested state, given the message's entry in the list (`undefined` when it has none). */
export type SavedLook = (entry: SavedEntry | undefined) => boolean

/** Whether a read-back ran: `skipped` when the call was cancelled by then, `failed` when it threw. */
type ReadBackStatus = "done" | "failed" | "skipped"

/**
 * The read-back after an uncertain change: Discord's list of saved messages,
 * and whether the message's entry shows the requested state. Nothing is stored
 * from it. A failing read-back, or an answer that is not a list, is reported
 * as what is known, never thrown.
 */
async function readBack(
  session: ChatSession,
  { channel, message }: SavedRequest,
  look: SavedLook,
): Promise<{ status: ReadBackStatus; applied: boolean | null }> {
  if (session.signal?.aborted) return { status: "skipped", applied: null }
  let value: unknown
  try {
    value = await readSavedList(session)
  } catch {
    return { status: "failed", applied: null }
  }
  try {
    const entries = savedEntries(value)
    return {
      status: "done",
      applied: look(entries.find((entry) => entry.channel === channel && entry.message === message)),
    }
  } catch {
    return { status: "done", applied: null }
  }
}

/**
 * Sends the one request of a change to the saved list, once and never retried,
 * and returns Discord's answer. A cancellation, and any refusal or failure
 * known to happen before anything changed, is rethrown as it is for the caller
 * to inspect; anything else is `uncertain` after one read-back of the list,
 * which says in `details.applied` whether the message shows as asked for.
 */
export async function runSavedWrite(
  session: ChatSession,
  request: SavedRequest,
  look: SavedLook,
  uncertainMessage: string,
): Promise<unknown> {
  checkAbort(session.signal)
  try {
    return await session.client().write(request.method, savedPath(request.channel, request.message), {
      referer: request.referer,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(session.signal ? { signal: session.signal } : {}),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    if (isToolError(error) && error.code !== "uncertain") throw error
    const seen = await readBack(session, request, look)
    throw new ToolError("uncertain", uncertainMessage, {
      ...(error instanceof Error ? { cause: error } : {}),
      details: { applied: seen.applied, read_back: seen.status },
    })
  }
}
