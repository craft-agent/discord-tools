import { isToolError } from "../core"
import { checkLabel, pickLabel, type LabelPaths } from "../core/discord/labels"
import { suspendService } from "../core/discord/service"
import { runSync } from "../core/discord/sync"
import { tokenVariable } from "../core/discord/token"
import { PROJECT_PROFILE } from "../entry/profile"
import { ACCOUNT_FLAG, handleCommandError, parseCommandStateDir, parseFlagArgs, STATE_DIR_FLAG } from "./command-args"
import { EXIT_FAILED, EXIT_OK, type CommandIo } from "./command-io"
import { SERVICE_ID } from "./service"

/**
 * Runs one bounded sync, reporting counts only. Busy is benign; partial work
 * needs another run. Authentication failure stops the label's schedule.
 */
export async function runSyncCommand(argv: string[], io: CommandIo): Promise<number> {
  let stateDir: string
  let account: string | undefined
  try {
    const { values, rest } = parseFlagArgs(argv, { values: [ACCOUNT_FLAG, STATE_DIR_FLAG] })
    stateDir = parseCommandStateDir(rest, io, values[STATE_DIR_FLAG])
    account = values[ACCOUNT_FLAG]
    if (account !== undefined) checkLabel(account)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }
  let paths: LabelPaths
  try {
    paths = await pickLabel(stateDir, account)
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto" })
  }
  try {
    const result = await (io.syncRun ?? runSync)({
      stateDir,
      paths,
      tokenVariable: tokenVariable((io.profile ?? PROJECT_PROFILE).envPrefix, paths.label),
      env: io.env,
      signal: io.signal,
    })
    io.stdout(
      `Sync ${result.status}: requests=${result.requests}, channels=${result.channels}, stored=${result.stored}, deleted=${result.deleted}, skipped=${result.skipped}.\n`,
    )
    if (result.status === "partial") io.stdout("Run sync again to continue.\n")
    return result.status === "partial" ? EXIT_FAILED : EXIT_OK
  } catch (error) {
    if (isToolError(error) && error.code === "unauthenticated") {
      const exitCode = handleCommandError(error, io)
      try {
        await suspendService(SERVICE_ID, paths.label, io.serviceHost)
      } catch {
        io.stderr("The sync schedule could not be paused; uninstall it before retrying.\n")
      }
      return exitCode
    }
    return handleCommandError(error, io, { abortMessage: "Sync was cancelled." })
  }
}
