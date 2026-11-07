import { checkLabel, pickLabel } from "../core/discord/labels"
import { removeLabel } from "../core/discord/removal"
import { defaultServiceHost, uninstallService, type ServiceHost } from "../core/discord/service"
import {
  ACCOUNT_FLAG,
  handleCommandError,
  parseCommandStateDir,
  parseFlagArgs,
  printCommandError,
  STATE_DIR_FLAG,
  usageError,
} from "./command-args"
import { defaultReadLine, EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { SERVICE_ID, serviceSupported } from "./service"

const YES_FLAG = "--yes"

type RemoveCommand = {
  label: string
  yes: boolean
  stateDir: string
}

function parseRemoveCommand(argv: string[], io: CommandIo): RemoveCommand {
  const { values, switches, rest } = parseFlagArgs(argv, {
    values: [ACCOUNT_FLAG, STATE_DIR_FLAG],
    switches: [YES_FLAG],
  })
  const stateDir = parseCommandStateDir(rest, io, values[STATE_DIR_FLAG])
  const account = values[ACCOUNT_FLAG]
  if (account === undefined) throw usageError(`Option ${ACCOUNT_FLAG} is required.`)
  return { label: checkLabel(account), yes: switches.has(YES_FLAG), stateDir }
}

/** Whether the person typed the label to confirm; no answer (input ended, or cancelled) is a refusal. */
async function confirmed(label: string, io: CommandIo): Promise<boolean> {
  io.stderr(`This will permanently delete the local state of "${label}": its token file and mirrored messages.\n`)
  const prompt = `To confirm, type the label "${label}": `
  const answer = await (io.readLine?.(prompt) ?? defaultReadLine(prompt, io.signal))
  return answer === label
}

/** Takes the account's sync service out of the manager, where the platform has one. */
async function uninstallSyncService(label: string, host: ServiceHost): Promise<void> {
  if (serviceSupported(host)) await uninstallService(SERVICE_ID, label, host)
}

/**
 * The `remove` command: deletes everything this machine keeps for one account
 * (`--account`, required), after its sync service is taken out of the
 * operating system's manager. It asks the person to type the label, unless
 * `--yes` is given; without a terminal `--yes` is required. Resolves to the
 * exit code: 0, 1 after a failure or a refusal, 2 for a mistake in the command
 * line.
 */
export async function runRemoveCommand(argv: string[], io: CommandIo): Promise<number> {
  let command: RemoveCommand
  try {
    command = parseRemoveCommand(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }
  const { yes, stateDir } = command

  if (!yes && !(io.isTTY ?? Boolean(process.stdin.isTTY))) {
    printCommandError(io, `Removing an account without a terminal requires ${YES_FLAG}.`)
    return EXIT_USAGE
  }

  try {
    io.signal?.throwIfAborted()
    const { label } = await pickLabel(stateDir, command.label)
    if (!yes && !(await confirmed(label, io))) {
      printCommandError(io, "Removal cancelled.")
      return EXIT_FAILED
    }

    io.signal?.throwIfAborted()
    const host = io.serviceHost ?? defaultServiceHost()
    await removeLabel({
      stateDir,
      label,
      uninstall: async () => {
        io.signal?.throwIfAborted()
        await uninstallSyncService(label, host)
        io.signal?.throwIfAborted()
      },
    })
    io.stdout(
      `Removed "${label}": its local state is deleted. Credentials supplied through the environment are not removed.\n`,
    )
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Removal was cancelled." })
  }
}
