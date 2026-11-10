import { plainHttpsUrl } from "./plain-https-url"

/** Where an upload goes, and how long it may take. */
export type UploadOptions = {
  /** The time limit of the request. */
  timeoutMs: number
  signal?: AbortSignal
  /** The web page the upload claims to come from; a path, as `RequestOptions.referer`. */
  referer: string
}

/**
 * What an upload came to. `refused` sent nothing. `failed` says whether the
 * request may have left (`dispatched`). An abort rejects with the `AbortError`.
 */
export type UploadResult =
  { status: "uploaded" } | { status: "refused"; why: string } | { status: "failed"; why: string; dispatched: boolean }

/** The signed URLs Discord hands out for an upload: one bucket host under Google Cloud Storage. */
const STORAGE_HOST = /^[a-z0-9-]+\.storage\.googleapis\.com$/

/** What `refused` says. */
export const NOT_STORAGE_URL = "not Discord's storage"

/** The URL as the transport must send it, when it is on Discord's storage host: `https`, no userinfo, the default port. */
export function storageUrl(url: string): URL | undefined {
  const parsed = plainHttpsUrl(url)
  if (!parsed) return undefined
  return STORAGE_HOST.test(parsed.hostname) ? parsed : undefined
}

/** Whether `url` is on Discord's storage host, the only place an upload goes. */
export function isStorageUrl(url: string): boolean {
  return storageUrl(url) !== undefined
}
