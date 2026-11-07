import { checkLabel } from "../core/discord/labels"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, printCommandError } from "./command-args"
import { EXIT_FAILED, type CommandIo } from "./command-io"

const ACCOUNT_FLAG = "--account"
const SYNC_UNAVAILABLE = "Sync is not available yet: the sync engine is not implemented."

/** Reads the flags of the command and checks them, with nothing looked up on disk. */
function checkSyncFlags(argv: string[], io: CommandIo): void {
  const { values, rest } = parseFlagArgs(argv, { values: [ACCOUNT_FLAG, "--state-dir"] })
  parseCommandStateDir(rest, io, values["--state-dir"])
  const account = values[ACCOUNT_FLAG]
  if (account !== undefined) checkLabel(account)
}

/**
 * The `sync` command (`--account`, `--state-dir`). Its flags are checked, then
 * it says there is no sync engine yet and resolves to 1: it reads no token and
 * touches no state, lock, mirror or network. A mistake in the command line
 * resolves to 2.
 */
export async function runSyncCommand(argv: string[], io: CommandIo): Promise<number> {
  try {
    checkSyncFlags(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }
  printCommandError(io, SYNC_UNAVAILABLE)
  return EXIT_FAILED
}
