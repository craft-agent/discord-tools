import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { readJsonFile, writePrivateFile } from "./private-file"

/** The wreq profile the client presents; the headers below claim the same browser. */
export const BROWSER_PROFILE = "chrome_149"

/** The version of that browser, as the user agent and the super properties state it. */
export const BROWSER_VERSION = "149.0.0.0"

/** The operating systems the client can claim to run on. */
export type ClientOs = "macos" | "linux"

/** The three `sec-ch-ua` headers of the claimed browser. */
export type ClientHints = { ua: string; mobile: string; platform: string }

/** The input needed to produce the web client's `x-super-properties`. */
export type SuperPropertiesInput = {
  os: ClientOs
  buildNumber: number
  launch: Launch
  systemLocale: string
}

/** How long a launch id lives before a new one is made, as the web client does per start. */
export const LAUNCH_TTL_MS = 24 * 60 * 60 * 1000

/** The locale used when the system gives none. */
const FALLBACK_LOCALE = "en-US"

/** The `sec-ch-ua` brand list of the claimed browser. */
const CHROME_BRANDS = '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"'
const CHROME_MOBILE_HINT = "?0"

type OsDetails = { name: string; version: string; userAgent: string; hintPlatform: string }

const OS_DETAILS: Record<ClientOs, OsDetails> = {
  macos: {
    name: "Mac OS X",
    version: "10.15.7",
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION} Safari/537.36`,
    hintPlatform: '"macOS"',
  },
  linux: {
    name: "Linux",
    version: "",
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION} Safari/537.36`,
    hintPlatform: '"Linux"',
  },
}

/** Discord's locale for a system locale tag, matched whole first and then by language. */
const DISCORD_LOCALES = new Map([
  ["ja", "ja"],
  ["ko", "ko"],
  ["zh-TW", "zh-TW"],
  ["zh", "zh-CN"],
  ["en-GB", "en-GB"],
  ["fr", "fr"],
  ["de", "de"],
  ["es", "es-ES"],
  ["pt", "pt-BR"],
  ["it", "it"],
  ["ru", "ru"],
])

/** The operating system of this machine; throws `internal_error` for one the client cannot claim. */
export function clientOs(platform: string = process.platform): ClientOs {
  if (platform === "darwin") return "macos"
  if (platform === "linux") return "linux"
  throw new ToolError("internal_error", `The platform "${platform}" is not supported; macOS and Linux are.`)
}

/** The user agent of the claimed browser on `os`. */
export function userAgent(os: ClientOs): string {
  return OS_DETAILS[os].userAgent
}

/**
 * The three `sec-ch-ua` headers of the claimed browser on `os`, as wreq's
 * profile sends them (a test holds them to it). They are written out rather
 * than read from wreq, so loading this module never loads its native part.
 */
export function clientHints(os: ClientOs): ClientHints {
  return { ua: CHROME_BRANDS, mobile: CHROME_MOBILE_HINT, platform: OS_DETAILS[os].hintPlatform }
}

/** The system's locale tag, such as `ja-JP`. */
export function locale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || FALLBACK_LOCALE
}

/** The locale Discord's web client reports for a system locale tag. */
export function discordLocale(tag: string): string {
  const language = tag.split("-", 1)[0]!
  return DISCORD_LOCALES.get(tag) ?? DISCORD_LOCALES.get(language) ?? FALLBACK_LOCALE
}

/** The `accept-language` value for a Discord locale tag. */
export function acceptLanguage(tag: string): string {
  const language = tag.split("-", 1)[0]!
  return language === "en" ? "en-US,en;q=0.9" : `${tag},${language};q=0.9,en-US;q=0.8,en;q=0.7`
}

/** The system's time zone, such as `Asia/Tokyo`, when it names one. */
export function timeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
}

/** One run of the web client: its ids, kept between runs for a day. */
export type Launch = { id: string; heartbeat: string; signature: string; started: number }

/** The bits a launch signature always has cleared. */
export const LAUNCH_SIGNATURE_BITS = BigInt(
  "0b00000000100000000001000000010000000010000001000000001000000000000010000010000001000000000100000000000001000000000000100000000000",
)

const UUID_BITS = 128n
const UUID_HEX_LENGTH = 32

/** A random UUID with `LAUNCH_SIGNATURE_BITS` cleared. */
export function launchSignature(): string {
  const random = BigInt(`0x${randomUUID().replaceAll("-", "")}`)
  const hex = (random & ~LAUNCH_SIGNATURE_BITS & ((1n << UUID_BITS) - 1n)).toString(16).padStart(UUID_HEX_LENGTH, "0")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function asLaunch(value: unknown): Launch | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { id, heartbeat, signature, started } = value as Record<string, unknown>
  if (
    typeof id !== "string" ||
    typeof heartbeat !== "string" ||
    typeof signature !== "string" ||
    typeof started !== "number" ||
    !Number.isFinite(started)
  ) {
    return undefined
  }
  return { id, heartbeat, signature, started }
}

/**
 * The label's launch ids from its client file, renewed when missing, malformed
 * or older than a day. A launch that cannot be saved still serves this run.
 */
export async function loadLaunch(paths: LabelPaths, now: number): Promise<Launch> {
  const saved = asLaunch(await readJsonFile(paths.client))
  if (saved && saved.started <= now && now - saved.started <= LAUNCH_TTL_MS) return saved

  const launch: Launch = { id: randomUUID(), heartbeat: randomUUID(), signature: launchSignature(), started: now }
  await writePrivateFile(paths.client, JSON.stringify(launch)).catch(() => {})
  return launch
}

/** The `x-super-properties` value: the web client's description of itself, as base64 of compact JSON. */
export function superProperties(input: SuperPropertiesInput): string {
  const details = OS_DETAILS[input.os]
  const properties = {
    os: details.name,
    browser: "Chrome",
    device: "",
    system_locale: input.systemLocale,
    has_client_mods: false,
    browser_user_agent: details.userAgent,
    browser_version: BROWSER_VERSION,
    os_version: details.version,
    referrer: "",
    referring_domain: "",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_build_number: input.buildNumber,
    client_event_source: null,
    client_launch_id: input.launch.id,
    launch_signature: input.launch.signature,
    client_heartbeat_session_id: input.launch.heartbeat,
    client_app_state: "focused",
  }
  return Buffer.from(JSON.stringify(properties)).toString("base64")
}
