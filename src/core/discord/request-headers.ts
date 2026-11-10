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

/** The headers of a file download from Discord's media hosts, in the order they are sent. */
export const MEDIA_HEADER_ORDER = [
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "user-agent",
  "accept",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
] as const

export type MediaHeaderInput = Pick<RequestHeaderInput, "os" | "hints" | "locale">

/**
 * The headers of a download: Chrome's for a cross-site image fetch from the
 * web client's page. It carries no token and none of the API's own headers.
 */
export function mediaHeaders(input: MediaHeaderInput): [string, string][] {
  const values: Record<(typeof MEDIA_HEADER_ORDER)[number], string> = {
    "sec-ch-ua": input.hints.ua,
    "sec-ch-ua-mobile": input.hints.mobile,
    "sec-ch-ua-platform": input.hints.platform,
    "user-agent": userAgent(input.os),
    accept: "*/*",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-dest": "image",
    referer: `${WEB_ORIGIN}/`,
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": acceptLanguage(input.locale),
  }
  return MEDIA_HEADER_ORDER.map((name) => [name, values[name]])
}

/** The headers of a file upload to Discord's storage, in the order they are sent. */
export const UPLOAD_HEADER_ORDER = [
  "sec-ch-ua-platform",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "user-agent",
  "accept",
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "referer",
  "accept-encoding",
  "accept-language",
] as const

export type UploadHeaderInput = Pick<RequestHeaderInput, "os" | "hints" | "locale" | "referer">

/**
 * The headers of an upload: Chrome's for a cross-site `fetch` from the web
 * client's page to the signed storage URL. It carries no token, none of the
 * API's own headers and no content type. The set follows the web client and is
 * not yet confirmed against Discord.
 */
export function uploadHeaders(input: UploadHeaderInput): [string, string][] {
  const values: Record<(typeof UPLOAD_HEADER_ORDER)[number], string> = {
    "sec-ch-ua-platform": input.hints.platform,
    "sec-ch-ua": input.hints.ua,
    "sec-ch-ua-mobile": input.hints.mobile,
    "user-agent": userAgent(input.os),
    accept: "*/*",
    origin: WEB_ORIGIN,
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    referer: `${WEB_ORIGIN}${input.referer}`,
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": acceptLanguage(input.locale),
  }
  return UPLOAD_HEADER_ORDER.map((name) => [name, values[name]])
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
