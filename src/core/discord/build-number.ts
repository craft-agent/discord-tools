import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { acceptLanguage, discordLocale, locale } from "./identity"
import { readJsonFile, writePrivateFile } from "./private-file"
import { type Transport, TransportFailure } from "./transport"

/** How long a read build number is used before the web client's page is read again. */
export const BUILD_TTL_MS = 12 * 60 * 60 * 1000

/** How long a cached build number still serves when reading the page fails. */
export const BUILD_STALE_OK_MS = 7 * 24 * 60 * 60 * 1000

const LOGIN_URL = "https://discord.com/login"
export const BUILD_CACHE_FILE = "build.json"
const PAGE_TIMEOUT_MS = 20_000
const BUILD_NUMBER_PATTERNS = [/"BUILD_NUMBER"\s*:\s*"?(\d+)/, /build_number:"(\d+)"/]
const DIR_MODE = 0o700

type BuildCache = { number: number; fetchedAt: number }

export type BuildNumberOptions = {
  /** Where `build.json` is cached, shared by every label. */
  stateDir: string
  /** Sends the page request; it carries no token. */
  transport: Transport
  now: () => number
  /** Waits for the client's turn before a request. */
  pace: () => Promise<void>
}

async function readCache(file: string, now: number): Promise<BuildCache | undefined> {
  const saved = await readJsonFile(file)
  if (typeof saved !== "object" || saved === null) return undefined
  const { number, fetchedAt } = saved as Record<string, unknown>
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return undefined
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt > now) return undefined
  return { number, fetchedAt }
}

function parseBuildNumber(page: string): number | undefined {
  for (const pattern of BUILD_NUMBER_PATTERNS) {
    const found = pattern.exec(page)?.[1]
    if (found) return Number(found)
  }
  return undefined
}

async function fetchBuildNumber(options: BuildNumberOptions): Promise<number | undefined> {
  const language = acceptLanguage(discordLocale(locale()))
  await options.pace()
  try {
    const response = await options.transport({
      method: "GET",
      url: LOGIN_URL,
      headers: [["accept-language", language]],
      navigation: true,
      timeoutMs: PAGE_TIMEOUT_MS,
    })
    return response.status === 200 ? parseBuildNumber(response.body) : undefined
  } catch (error) {
    if (error instanceof TransportFailure) return undefined
    throw error
  }
}

/**
 * The web client's current build number, cached in `<stateDir>/build.json`.
 *
 * A number under 12 hours old is used as it is; otherwise the login page is
 * read. When that fails, a cached number under 7 days old still serves, and
 * past that it throws `upstream_error` rather than claim a build that may no
 * longer exist.
 */
export async function buildNumber(options: BuildNumberOptions): Promise<number> {
  const file = join(options.stateDir, BUILD_CACHE_FILE)
  const cached = await readCache(file, options.now())
  if (cached && options.now() - cached.fetchedAt < BUILD_TTL_MS) return cached.number

  const fetched = await fetchBuildNumber(options)
  if (fetched !== undefined) {
    const entry: BuildCache = { number: fetched, fetchedAt: options.now() }
    // A cache that cannot be saved costs a fetch next time, not this request.
    await mkdir(options.stateDir, { recursive: true, mode: DIR_MODE })
      .then(() => writePrivateFile(file, JSON.stringify(entry)))
      .catch(() => {})
    return fetched
  }

  if (cached && options.now() - cached.fetchedAt < BUILD_STALE_OK_MS) return cached.number
  throw new ToolError("upstream_error", "Could not read Discord's current client build number; no request was sent.")
}
