import { chmod, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { ToolError } from "../errors"
import { exec, type ExecResult } from "../exec"
import { checkLabel } from "./labels"
import { maskTokens } from "./mask"

/** Seconds between two sync runs: the scheduler's interval on both platforms. */
export const SYNC_INTERVAL_SECONDS = 300

/** How much of a program's stderr is kept in an upstream_error message. */
const MAX_PROGRAM_ERROR_LENGTH = 300

/** How long a service management command may run before it is stopped. */
const RUN_TIMEOUT_MS = 30_000

/** The variables of the caller's environment a service management command receives, when set. */
const FORWARDED_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]

/** Variables every service management command gets, so its output is stable text. */
const FIXED_ENV = { LC_ALL: "C", NO_COLOR: "1" }

/** Mode of service definition files. */
const DEFINITION_FILE_MODE = 0o644

/** A safe file name and reverse-DNS prefix: letters, digits, `.`, `_` and `-`, starting with a letter or digit. */
const SERVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Maximum character length of a bad id shown in error messages. */
const MAX_BAD_ID_PREVIEW = 40

/** Control characters (U+0000–U+001F, U+007F), which break line-oriented configs and XML. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/

/** The specification for installing the scheduled sync of one label. */
export type ServiceSpec = {
  /** The reverse-DNS prefix of the service's names, supplied by the entry point. */
  id: string
  /** The account label this service syncs. */
  label: string
  /** What the service is for, shown by the service manager. */
  description: string
  /** The absolute path of the program to run. */
  program: string
  /** The program's arguments. */
  args: string[]
  /** The `PATH` value the program runs with. */
  path: string
}

/** The host the service commands run on. */
export type ServiceHost = {
  /** The host platform (`darwin`, `linux`, ...). */
  platform: NodeJS.Platform
  /** The user's absolute home directory. */
  home: string
  /** The user id whose agents are managed. */
  uid: number
  /** The caller's environment. */
  env: Record<string, string | undefined>
  /** Runs a program without a shell; rejects when it cannot be started. */
  run(argv: string[]): Promise<ExecResult>
}

/** The state of one label's scheduled sync. */
export type ServiceStatus = {
  /** Whether the service definition exists on disk. */
  installed: boolean
  /** Whether the scheduler has the job registered, waiting for its next run or running. */
  scheduled: boolean
  /** Whether a run is in progress now. */
  running: boolean
  /** The process id of the run in progress. */
  pid?: number
  /** The exit code of the most recent finished run, when known. */
  lastExit?: number
  /** The service definition file. */
  file: string
  /** The timer definition file (Linux). */
  timer?: string
  /** Where the logs are: a file (macOS) or a journalctl command (Linux). */
  log?: string
}

/** What installing a service reports. */
export type ServiceInstallResult = Pick<ServiceStatus, "file" | "timer" | "log">

/** Maps a failed program result to an `upstream_error` naming the program and its masked, truncated stderr. */
export function mapProgramError(program: string, result: ExecResult): ToolError {
  if (result.timedOut) {
    return new ToolError("upstream_error", `${program} timed out after ${RUN_TIMEOUT_MS / 1000} seconds.`)
  }
  const detail = maskTokens(result.stderr).trim().slice(0, MAX_PROGRAM_ERROR_LENGTH)
  return new ToolError("upstream_error", `${program} failed${detail ? `: ${detail}` : "."}`)
}

/** Whether a program exited with code 0 on its own; a timed-out or killed run never succeeded. */
export function runSucceeded(result: ExecResult): boolean {
  return result.code === 0 && !result.timedOut && !result.signal
}

/**
 * Whether a failed result is the scheduler saying the job is not there: a normal non-zero exit with one of `codes`
 * (any when omitted) and output matching `known`. Timeouts, signals and any other failure are not absence.
 */
export function isKnownAbsent(result: ExecResult, known: RegExp, codes?: readonly number[]): boolean {
  if (result.code <= 0 || result.timedOut || result.signal) return false
  if (codes && !codes.includes(result.code)) return false
  return known.test(`${result.stderr}\n${result.stdout}`)
}

function checkServiceId(id: string): void {
  if (typeof id !== "string" || !SERVICE_ID_PATTERN.test(id) || id.includes("..")) {
    const preview = typeof id === "string" ? id.slice(0, MAX_BAD_ID_PREVIEW) : String(id)
    throw new ToolError(
      "invalid_argument",
      `Invalid service id ${JSON.stringify(preview)}: use letters, digits, ".", "_" and "-", starting with a letter or digit, without "..".`,
    )
  }
}

/** Refuses an id or label that is not safe to put in a name or path, and a relative home, before anything runs. */
export function checkServiceTarget(id: string, label: string, home: string): void {
  checkServiceId(id)
  checkLabel(label)
  if (!isAbsolute(home)) {
    throw new ToolError("internal_error", `Home directory must be absolute; got ${JSON.stringify(home)}.`)
  }
}

/** Refuses a spec whose target is unsafe, whose text holds control characters or whose program is not absolute. */
export function checkServiceSpec(spec: ServiceSpec, home: string): void {
  checkServiceTarget(spec.id, spec.label, home)
  const texts: [string, string][] = [
    ["the description", spec.description],
    ["the program", spec.program],
    ...spec.args.map((arg): [string, string] => ["an argument", arg]),
    ["PATH", spec.path],
  ]
  for (const [name, text] of texts) {
    if (CONTROL_CHARACTERS.test(text)) {
      throw new ToolError("invalid_argument", `Control characters are not allowed in ${name}.`)
    }
  }
  if (!isAbsolute(spec.program)) {
    throw new ToolError(
      "invalid_argument",
      `The program must be an absolute path; got ${JSON.stringify(spec.program)}.`,
    )
  }
}

/** Default host: this process's platform, home and environment, running programs with a fixed environment. */
export function defaultServiceHost(): ServiceHost {
  const env = process.env
  return {
    platform: process.platform,
    home: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    env,
    async run(argv: string[]): Promise<ExecResult> {
      const commandEnv: Record<string, string> = { ...FIXED_ENV }
      for (const name of FORWARDED_ENV) {
        const value = env[name]
        if (value !== undefined) commandEnv[name] = value
      }
      try {
        return await exec(argv, { env: commandEnv, timeoutMs: RUN_TIMEOUT_MS })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const detail = maskTokens(reason).slice(0, MAX_PROGRAM_ERROR_LENGTH)
        throw new ToolError("upstream_error", `${argv[0]} could not be started: ${detail}`, { cause: error })
      }
    },
  }
}

/** Whether `path` is a regular file; only a missing path is `false`, any other failure throws. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

/** Writes a service definition with mode 0644, whatever the umask or an earlier file's mode. */
export async function writeDefinitionFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", mode: DEFINITION_FILE_MODE })
  await chmod(path, DEFINITION_FILE_MODE)
}

/** Deletes `path`; a file that is already gone is fine. */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
