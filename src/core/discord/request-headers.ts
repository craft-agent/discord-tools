import { type ClientHints, type ClientOs, acceptLanguage, userAgent } from "./identity"

/** The headers of an API request, in the order they are sent. */
export const REQUEST_HEADER_ORDER = [
  "sec-ch-ua-platform",
  "authorization",
  "x-debug-options",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "x-discord-timezone",
  "x-super-properties",
  "x-discord-locale",
  "x-audit-log-reason",
  "user-agent",
  "content-type",
  "accept",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
  "priority",
] as const

type RequestHeaderName = (typeof REQUEST_HEADER_ORDER)[number]

/** The page the web client sends requests from. */
export const WEB_ORIGIN = "https://discord.com"

/** The page a request claims to come from when it names none. */
export const DEFAULT_REFERER = "/channels/@me"

export type RequestHeaderInput = {
  os: ClientOs
  token: string
  /** The three `sec-ch-ua` values of the claimed browser. */
  hints: ClientHints
  superProperties: string
  /** Discord's locale for the system. */
  locale: string
  timeZone: string | undefined
  referer: string
  reason: string | undefined
  hasBody: boolean
}

/** Percent-encodes a reason the way the web client does: spaces and slashes stay. */
function encodeReason(reason: string): string {
  return encodeURIComponent(reason)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%2F", "/")
    .replaceAll("%20", " ")
}

/** The headers of one API request, in `REQUEST_HEADER_ORDER`, without those that do not apply. */
export function requestHeaders(input: RequestHeaderInput): [string, string][] {
  const values: Record<RequestHeaderName, string | undefined> = {
    "sec-ch-ua-platform": input.hints.platform,
    authorization: input.token,
    "x-debug-options": "bugReporterEnabled",
    "sec-ch-ua": input.hints.ua,
    "sec-ch-ua-mobile": input.hints.mobile,
    "x-discord-timezone": input.timeZone,
    "x-super-properties": input.superProperties,
    "x-discord-locale": input.locale,
    "x-audit-log-reason": input.reason ? encodeReason(input.reason) : undefined,
    "user-agent": userAgent(input.os),
    "content-type": input.hasBody ? "application/json" : undefined,
    accept: "*/*",
    origin: WEB_ORIGIN,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    referer: `${WEB_ORIGIN}${input.referer}`,
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": acceptLanguage(input.locale),
    priority: "u=1, i",
  }
  return REQUEST_HEADER_ORDER.flatMap((name) => {
    const value = values[name]
    return value === undefined ? [] : [[name, value] as [string, string]]
  })
}
