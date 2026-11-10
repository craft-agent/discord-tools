import { constants } from "node:fs"
import { type FileHandle, open } from "node:fs/promises"
import { plainHttpsUrl } from "./plain-https-url"
import type { DownloadResponse } from "./transport"

/** Where a download goes, and how much it may be. */
export type DownloadOptions = {
  /** The file to create; it must not exist, and a link there is not followed. */
  to: string
  /** The most bytes the file may have. */
  maxBytes: number
  /** The time limit of the request and of reading its body. */
  timeoutMs: number
  signal?: AbortSignal
  /** The size Discord declared for the file; a larger one than `maxBytes` is refused without a request. */
  declaredSize?: number
}

/**
 * What a download came to. A `saved` file is at `to`; any other result leaves
 * no file. A file that cannot be created (it exists, a link is there, the
 * directory is missing) is `failed` before any request, not a throw. An abort
 * rejects with the `AbortError`.
 */
export type DownloadResult =
  /** `type` is the response's content type, in lower case and without parameters. */
  | { status: "saved"; size: number; type?: string }
  | { status: "too_large" }
  | { status: "refused"; why: string }
  | { status: "missing"; why: string }
  | { status: "failed"; why: string }

/** The hosts files come from: Discord's CDN and its media proxy. */
const MEDIA_HOSTS: ReadonlySet<string> = new Set(["cdn.discordapp.com", "media.discordapp.net"])

/** The media proxy's numbered hosts. */
const MEDIA_PROXY_HOST = /^images-ext-\d+\.discordapp\.net$/

/** Mode of a downloaded file: owner read/write only, and never an execute bit. */
const DOWNLOAD_FILE_MODE = 0o600

/** A new file only: an existing one, or a link in its place, is never opened. */
const DOWNLOAD_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/** What `refused` says. */
export const NOT_MEDIA_URL = "not on Discord's media hosts"

/** The URL as the transport must send it, when it is on Discord's media hosts: `https`, no userinfo, the default port. */
export function mediaUrl(url: string): URL | undefined {
  const parsed = plainHttpsUrl(url)
  if (!parsed) return undefined
  return MEDIA_HOSTS.has(parsed.hostname) || MEDIA_PROXY_HOST.test(parsed.hostname) ? parsed : undefined
}

/** Whether `url` is a file on Discord's CDN or media proxy, the only places a download comes from. */
export function isMediaUrl(url: string): boolean {
  return mediaUrl(url) !== undefined
}

/** Creates the file for a download; rejects when it exists, is a link, or its directory is missing. */
export function createDownloadFile(path: string): Promise<FileHandle> {
  return open(path, DOWNLOAD_FILE_FLAGS, DOWNLOAD_FILE_MODE)
}

function declaredLength(headers: Record<string, string>): number | undefined {
  const value = headers["content-length"]?.trim()
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

function contentType(headers: Record<string, string>): string | undefined {
  return headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() || undefined
}

/**
 * Writes the body of `response` to `file`, chunk by chunk, up to `maxBytes`;
 * the answer's status and `content-length` are held to the same limits first.
 * The body is cancelled whatever the outcome. Throws what reading or writing
 * threw; the caller removes the file unless the result is `saved`.
 */
export async function receiveDownload(
  response: DownloadResponse,
  file: FileHandle,
  maxBytes: number,
): Promise<DownloadResult> {
  try {
    if (response.status < 200 || response.status >= 300) {
      return { status: "missing", why: `Discord's media host answered ${response.status}` }
    }
    const declared = declaredLength(response.headers)
    if (declared !== undefined && declared > maxBytes) return { status: "too_large" }
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > maxBytes) return { status: "too_large" }
      await file.writeFile(chunk)
    }
    const type = contentType(response.headers)
    return { status: "saved", size, ...(type === undefined ? {} : { type }) }
  } finally {
    await response.cancel()
  }
}
