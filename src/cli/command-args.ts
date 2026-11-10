import { isAbortError, isToolError, ToolError } from "../core"
import { maskTokens } from "../core/discord/mask"
import { PROJECT_PROFILE } from "../entry/profile"
import { parseStorageSettings } from "../entry/settings"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_USAGE, type CommandIo } from "./command-io"

/** The flags the account commands share. */
export const ACCOUNT_FLAG = "--account"
export const STATE_DIR_FLAG = "--state-dir"

/** The flags a command takes: those with a value (`--flag value` or `--flag=value`) and the switches. */
export type FlagParserSpec<V extends string = string, S extends string = string> = {
  values?: readonly V[]
  switches?: readonly S[]
}

/** What `parseFlagArgs` found; `rest` is every argument that is not one of the given flags. */
export type ParsedFlagArgs<V extends string, S extends string> = {
  values: Partial<Record<V, string>>
  switches: Set<S>
  rest: string[]
}

/** The error for a mistake in the command line. */
export function usageError(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Writes one line on standard error, led by the program's name. */
export function printCommandError(io: CommandIo, message: string): void {
  io.stderr(`${PROJECT.cli}: ${message}\n`)
}

/** How `handleCommandError` chooses the exit code of a `ToolError`. */
export type CommandErrorMode =
  /** Always `EXIT_FAILED`: the work failed. */
  | "failed"
  /** Always `EXIT_USAGE`: the command line was wrong. */
  | "usage"
  /** `EXIT_USAGE` for `invalid_argument`, else `EXIT_FAILED`: the command line named something that is not there. */
  | "auto"

/** What `handleCommandError` says and answers with. */
export type CommandErrorOptions = {
  /** What to say when the command was cancelled; a cancellation is an unexpected error without it. */
  abortMessage?: string
  /** Defaults to `"failed"`. */
  mode?: CommandErrorMode
}

const UNEXPECTED_MESSAGE = "Unexpected error; the command failed."

/**
 * Says a failure on standard error as one line, with anything shaped like a
 * token masked, and answers with the exit code. An error that is not a
 * `ToolError` or a cancellation is said generically: no stack, no detail.
 */
export function handleCommandError(error: unknown, io: CommandIo, options: CommandErrorOptions = {}): number {
  if (isToolError(error)) {
    printCommandError(io, maskTokens(error.message))
    const { mode = "failed" } = options
    if (mode === "usage") return EXIT_USAGE
    if (mode === "auto" && error.code === "invalid_argument") return EXIT_USAGE
    return EXIT_FAILED
  }
  if (options.abortMessage !== undefined && isAbortError(error)) {
    printCommandError(io, options.abortMessage)
    return EXIT_FAILED
  }
  printCommandError(io, UNEXPECTED_MESSAGE)
  return EXIT_FAILED
}

/**
 * Takes the value flags and the switches out of `argv` and leaves the rest,
 * for a parser that rejects what it does not know. A value flag without a
 * value, or a switch with one, is a usage error.
 */
export function parseFlagArgs<V extends string = string, S extends string = string>(
  argv: string[],
  spec: FlagParserSpec<V, S>,
): ParsedFlagArgs<V, S> {
  const values: Partial<Record<V, string>> = {}
  const switches = new Set<S>()
  const rest: string[] = []
  const valueFlags = new Set<string>(spec.values)
  const switchFlags = new Set<string>(spec.switches)

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.indexOf("=")
    const flag = equals === -1 ? arg : arg.slice(0, equals)

    if (valueFlags.has(flag)) {
      const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
      if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) {
        throw usageError(`Option ${flag} needs a value.`)
      }
      values[flag as V] = value
    } else if (switchFlags.has(flag)) {
      if (equals !== -1) throw usageError(`Option ${flag} takes no value.`)
      switches.add(flag as S)
    } else {
      rest.push(arg)
    }
  }

  return { values, switches, rest }
}

/** Reads the state directory from the arguments `parseFlagArgs` left, where nothing else may remain. */
export function parseCommandStateDir(rest: string[], io: CommandIo, stateDir?: string): string {
  const args = stateDir === undefined ? rest : [...rest, `${STATE_DIR_FLAG}=${stateDir}`]
  return parseStorageSettings(args, io.env, io.profile ?? PROJECT_PROFILE).state_dir
}
