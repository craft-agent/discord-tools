import { abortError } from "../core"
import {
  type DiscordClient,
  type DiscordClientOptions,
  createDiscordClient,
  GATEWAY_READY_TIMEOUT_MS,
} from "../core/discord/client"
import { checkLabel, pickLabel, type LabelPaths } from "../core/discord/labels"
import { tokenVariable } from "../core/discord/token"
import { PROJECT_PROFILE } from "../entry/profile"
import {
  ACCOUNT_FLAG,
  handleCommandError,
  parseCommandStateDir,
  parseFlagArgs,
  STATE_DIR_FLAG,
  usageError,
} from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

const TIMES_FLAG = "--times"
const INTERVAL_FLAG = "--interval"

/** How many sessions the check opens, and how far apart in seconds, with the limits of each. */
const DEFAULT_TIMES = 5
const MIN_TIMES = 1
const MAX_TIMES = 20
const DEFAULT_INTERVAL_S = 30
const MIN_INTERVAL_S = 10
const MAX_INTERVAL_S = 600

const MS_PER_SECOND = 1000

/** What the person does around the rounds; the check itself only opens and closes sessions. */
const PROCEDURE = [
  "Before the first round:",
  "  1. Close every other Discord client signed in to this account (desktop app, browser tabs).",
  "  2. Lock the phone and leave Discord closed on it.",
  "While the rounds run:",
  "  3. From another account, send this account a direct message and a message that mentions it.",
  "  4. Note whether each push notification reaches the phone, and when.",
  "Each round opens the gateway, reads READY and closes the session with code 1000 at once. Nothing is sent but Identify,",
  "nothing is stored, and no token or message text is printed.",
  "",
]

const RECORD_RESULT =
  "Record the date, the phone's OS, the Discord app version and whether each push arrived on the issue tracker."

/** What the command needs besides the command line; tests supply their own. */
export type GatewayCheckDeps = {
  /** Makes the client the rounds use; defaults to the real one. */
  createClient?: (options: DiscordClientOptions) => Pick<DiscordClient, "gatewayReady">
  /** Waits `ms`; rejects with an `AbortError` when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** The local time of a round. */
  now?: () => Date
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** A whole number within the limits, or the default when the option is absent. */
function wholeNumber(flag: string, text: string | undefined, fallback: number, min: number, max: number): number {
  if (text === undefined) return fallback
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!(value >= min && value <= max)) throw usageError(`Option ${flag} needs a whole number from ${min} to ${max}.`)
  return value
}

function localTime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0")
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  return `${day} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/**
 * Opens and closes the gateway as a sync run will, several times at intervals,
 * for the check on a real phone that decides whether a run may open it. Each
 * round says when it ended, how long READY took, how many read states it held
 * and whether they were partial. A failing round ends the check.
 */
export async function runGatewayCheckCommand(
  argv: string[],
  io: CommandIo,
  deps: GatewayCheckDeps = {},
): Promise<number> {
  let stateDir: string
  let account: string | undefined
  let times: number
  let intervalS: number
  try {
    const { values, rest } = parseFlagArgs(argv, {
      values: [ACCOUNT_FLAG, STATE_DIR_FLAG, TIMES_FLAG, INTERVAL_FLAG],
    })
    stateDir = parseCommandStateDir(rest, io, values[STATE_DIR_FLAG])
    account = values[ACCOUNT_FLAG]
    if (account !== undefined) checkLabel(account)
    times = wholeNumber(TIMES_FLAG, values[TIMES_FLAG], DEFAULT_TIMES, MIN_TIMES, MAX_TIMES)
    intervalS = wholeNumber(INTERVAL_FLAG, values[INTERVAL_FLAG], DEFAULT_INTERVAL_S, MIN_INTERVAL_S, MAX_INTERVAL_S)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }
  let paths: LabelPaths
  try {
    paths = await pickLabel(stateDir, account)
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto" })
  }

  const client = (deps.createClient ?? createDiscordClient)({
    stateDir,
    paths,
    tokenVariable: tokenVariable((io.profile ?? PROJECT_PROFILE).envPrefix, paths.label),
    env: io.env,
  })
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => new Date())

  io.stdout(
    `Gateway check for account "${paths.label}": ${times} sessions, ${intervalS} s apart.\n${PROCEDURE.join("\n")}\n`,
  )
  try {
    for (let round = 1; round <= times; round++) {
      if (round > 1) await sleep(intervalS * MS_PER_SECOND, io.signal)
      const ready = await client.gatewayReady({ timeoutMs: GATEWAY_READY_TIMEOUT_MS, signal: io.signal })
      io.stdout(
        `Round ${round}/${times} at ${localTime(now())}: READY after ${ready.ms} ms, ${ready.readStates.length} read states, partial: ${ready.partial ? "yes" : "no"}; session closed.\n`,
      )
    }
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "The gateway check was cancelled." })
  }
  io.stdout(`Done: ${times} sessions opened and closed. ${RECORD_RESULT}\n`)
  return EXIT_OK
}
