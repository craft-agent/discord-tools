import { checkLabel, listLabels, pickLabel } from "../core/discord/labels"
import {
  defaultServiceHost,
  serviceStatus,
  uninstallService,
  type ServiceHost,
  type ServiceStatus,
} from "../core/discord/service"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, printCommandError, usageError } from "./command-args"
import { EXIT_FAILED, EXIT_OK, type CommandIo } from "./command-io"

/** The identity the sync service of every label is registered under with the operating system's manager. */
export const SERVICE_ID = "io.github.craft-agent.discord-tools"

const ACCOUNT_FLAG = "--account"
const INSTALL_UNAVAILABLE = "Installing the sync service is not available yet: the sync engine is not implemented."

/** The platforms whose service manager the sync service is registered with. */
const SERVICE_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"]

/** Whether the host has a service manager to register the sync service with. */
export function serviceSupported(host: ServiceHost): boolean {
  return SERVICE_PLATFORMS.includes(host.platform)
}

type ServiceAction = "install" | "uninstall" | "status"

type ServiceCommand = {
  action: ServiceAction
  /** The label as given, checked for its spelling only. */
  account: string | undefined
  stateDir: string
}

function parseServiceCommand(argv: string[], io: CommandIo): ServiceCommand {
  const [action, ...args] = argv
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    const given = action === undefined ? "No service command given" : `Unknown service command "${action}"`
    throw usageError(`${given}; use service install|uninstall|status.`)
  }
  const { values, rest } = parseFlagArgs(args, { values: [ACCOUNT_FLAG, "--state-dir"] })
  const account = values[ACCOUNT_FLAG]
  return {
    action,
    account: account === undefined ? undefined : checkLabel(account),
    stateDir: parseCommandStateDir(rest, io, values["--state-dir"]),
  }
}

/**
 * The label to act on. One given by name is taken as it is, so a registration
 * left behind by a removed account can still be cleaned up; without one the
 * account is the only one in the state directory.
 */
async function resolveLabel(command: ServiceCommand): Promise<string> {
  if (command.account !== undefined) return command.account
  const labels = await listLabels(command.stateDir)
  if (labels.length > 1) {
    throw usageError(`Several Discord accounts are signed in; name one with ${ACCOUNT_FLAG}: ${labels.join(", ")}.`)
  }
  return (await pickLabel(command.stateDir, undefined)).label
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no"
}

function statusLines(label: string, status: ServiceStatus): string[] {
  return [
    `Sync service for "${label}":`,
    `  Installed: ${yesNo(status.installed)}`,
    `  Scheduled: ${yesNo(status.scheduled)}`,
    `  Running: ${yesNo(status.running)}`,
    ...(status.pid === undefined ? [] : [`  PID: ${status.pid}`]),
    ...(status.lastExit === undefined ? [] : [`  Last exit: ${status.lastExit}`]),
    `  File: ${status.file}`,
    ...(status.timer === undefined ? [] : [`  Timer: ${status.timer}`]),
    ...(status.log === undefined ? [] : [`  Log: ${status.log}`]),
  ]
}

/**
 * The `service` command: `install`, `uninstall` and `status` of one account's
 * sync service (`--account`, or the only account). Installing is refused for
 * now, before anything is read or written, as there is no sync engine to run.
 * `uninstall` and `status` take a named account whose state is gone. Resolves
 * to the exit code: 0, 1 after a failure, 2 for a mistake in the command line.
 */
export async function runServiceCommand(argv: string[], io: CommandIo): Promise<number> {
  let command: ServiceCommand
  try {
    command = parseServiceCommand(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  if (command.action === "install") {
    printCommandError(io, INSTALL_UNAVAILABLE)
    return EXIT_FAILED
  }

  let label: string
  try {
    label = await resolveLabel(command)
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    const host: ServiceHost = io.serviceHost ?? defaultServiceHost()
    if (command.action === "uninstall") {
      await uninstallService(SERVICE_ID, label, host)
      io.stdout(`Uninstalled sync service for "${label}".\n`)
    } else {
      io.stdout(`${statusLines(label, await serviceStatus(SERVICE_ID, label, host)).join("\n")}\n`)
    }
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "The service command was cancelled." })
  }
}
