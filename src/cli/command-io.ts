import { createInterface } from "node:readline/promises"
import { isAbortError } from "../core"
import type { runSync } from "../core/discord/sync"
import type { RuntimeOptions } from "../entry/runtime"

/** The exit codes of a command: it did its work, the work failed, or the command line was wrong. */
export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

/** What a command of the command line needs from its surroundings; `main.ts` wires the process, a test supplies its own. */
export type CommandIo = RuntimeOptions & {
  /** Where the `<envPrefix>_*` settings fall back to. */
  env: Record<string, string | undefined>
  /** Receives what a command says to the person, or the JSON document a command answers with. */
  stdout(text: string): void
  /** Receives usage lines, errors and the detail of unexpected errors. */
  stderr(text: string): void
  /** Stops a running command when it aborts. */
  signal?: AbortSignal
  /** Whether standard input is an interactive terminal; defaults to the process's own. */
  isTTY?: boolean
  /** Asks the person one question and reads the answer; `undefined` when there is none. Defaults to `defaultReadLine`. */
  readLine?(prompt: string): Promise<string | undefined>
  /** Runs one bounded sync; tests inject an offline implementation. */
  syncRun?: typeof runSync
  /** Absolute runtime executable used by the scheduled service. */
  program?: string
  /** The version of `program` without a leading `v`; defaults to `process.versions.node`. */
  version?: string
  /** Absolute built CLI entry path, supplied by the executable entry point. */
  entryPath?: string
}

/**
 * Asks one question on the terminal and reads one line from standard input.
 * The prompt goes to standard error, so standard output stays for results.
 * Resolves to `undefined` when input ends or `signal` aborts, never hangs.
 */
export async function defaultReadLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const ended = new Promise<undefined>((resolve) => rl.once("close", () => resolve(undefined)))
  try {
    return await Promise.race([rl.question(prompt, { signal }), ended])
  } catch (error) {
    if (isAbortError(error)) return undefined
    throw error
  } finally {
    rl.close()
  }
}
