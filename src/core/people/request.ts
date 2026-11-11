import type { ChatSession } from "../chats/session"
import type { RequestOptions } from "../discord/client"
import { type ErrorCode, ToolError, isToolError } from "../errors"

/** Reads `path` live for the session, with its abort signal. A POST here changes nothing and goes the client's read path. */
export function readLive(
  session: ChatSession,
  method: "GET" | "POST",
  path: string,
  options: RequestOptions = {},
): Promise<unknown> {
  return session.client().read(method, path, { ...options, ...(session.signal ? { signal: session.signal } : {}) })
}

/**
 * Throws `error` again; a refusal whose code has a hint in `hints` keeps its
 * code and details and says the hint ahead of Discord's own (already masked)
 * message.
 */
export function explainRefusal(error: unknown, hints: Partial<Record<ErrorCode, string>>): never {
  const hint = isToolError(error) ? hints[error.code] : undefined
  if (!isToolError(error) || hint === undefined) throw error
  throw new ToolError(error.code, `${hint} (${error.message})`, error.details ? { details: error.details } : {})
}
