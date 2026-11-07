import { ToolError } from "../errors"
import { maskTokens } from "./mask"

/** The error code of a 401 that asks for a fresh two-factor check. */
const MFA_REQUIRED_CODE = 60003

/** Seconds to wait when Discord does not say how long. */
const DEFAULT_RETRY_AFTER_S = 5

/** Longest Discord message kept in an error. */
const MAX_DETAIL_LENGTH = 300

type Body = Record<string, unknown>

function asObject(body: unknown): Body | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Body) : undefined
}

/** The parsed JSON of a response body, or `undefined` when it is empty or not JSON. */
export function parseJson(text: string): unknown {
  try {
    return text.trim() === "" ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Seconds to wait after a rate limit: the body's `retry_after`, else the `retry-after` header, else 5. */
export function retryAfter(headers: Record<string, string>, body: unknown): number {
  const fromBody = asObject(body)?.retry_after
  if (typeof fromBody === "number" && Number.isFinite(fromBody)) return fromBody
  const fromHeader = Number(headers["retry-after"] ?? DEFAULT_RETRY_AFTER_S)
  return Number.isFinite(fromHeader) ? fromHeader : DEFAULT_RETRY_AFTER_S
}

/** Whether a 401 is a two-factor challenge: the token is good, and the action needs the person. */
export function requiresTwoFactor(status: number, body: unknown): boolean {
  const object = asObject(body)
  return status === 401 && (object?.code === MFA_REQUIRED_CODE || Boolean(object?.mfa))
}

function detailOf(status: number, body: unknown, token: string | undefined): string {
  const object = asObject(body)
  const code = typeof object?.code === "number" ? ` (code ${object.code})` : ""
  const message = typeof object?.message === "string" ? `: ${object.message.slice(0, MAX_DETAIL_LENGTH)}` : ""
  return maskTokens(`Discord answered ${status}${code}${message}`, token)
}

/**
 * Maps a non-2xx answer to the error it stands for, with Discord's code and
 * message (masked) in the text. A 401 that is not a two-factor challenge means
 * the token was rejected; recording that is the caller's.
 */
export function httpError(status: number, headers: Record<string, string>, body: unknown, token?: string): ToolError {
  if (requiresTwoFactor(status, body)) {
    return new ToolError(
      "forbidden",
      "Discord asked for two-factor verification for this action; nothing was done. Do it in the Discord app.",
    )
  }
  if (status === 401) {
    return new ToolError("unauthenticated", "Discord rejected the token (401); give this account a new token.")
  }
  if (asObject(body)?.captcha_key) {
    return new ToolError("forbidden", "Discord asked for a captcha; do it in the Discord app.")
  }
  const detail = detailOf(status, body, token)
  if (status === 429) {
    const seconds = Math.ceil(retryAfter(headers, body))
    return new ToolError("rate_limited", `Discord rate-limited the request; retry after ${seconds}s.`)
  }
  if (status === 400) return new ToolError("invalid_argument", detail)
  if (status === 403) return new ToolError("forbidden", detail)
  if (status === 404) return new ToolError("not_found", detail)
  return new ToolError("upstream_error", detail)
}
