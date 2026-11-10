import { isAbsolute } from "node:path"
import { ToolError } from "../core"
import { readAccount } from "../core/discord/account-meta"
import { checkLabel, listLabels, pickLabel } from "../core/discord/labels"
import {
  defaultServiceHost,
  installService,
  serviceStatus,
  uninstallService,
  type ServiceHost,
  type ServiceName,
  type ServiceStatus,
} from "../core/discord/service"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import {
  ACCOUNT_FLAG,
  handleCommandError,
  parseCommandStateDir,
  parseFlagArgs,
  STATE_DIR_FLAG,
  usageError,
} from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

/** The platforms whose service manager the sync service is registered with. */
const SERVICE_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"]

/** Whether the host has a service manager to register the sync service with. */
export function serviceSupported(host: ServiceHost): boolean {
  return SERVICE_PLATFORMS.includes(host.platform)
}

/** What names the profile's service on disk: its id, and the launcher Login Items lists on macOS, before `-<label>`. */
export function serviceName(profile: EntryProfile): ServiceName {
  return { id: profile.serviceId, launcher: `${profile.name}-sync` }
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
  const { values, rest } = parseFlagArgs(args, { values: [ACCOUNT_FLAG, STATE_DIR_FLAG] })
  const account = values[ACCOUNT_FLAG]
  return {
    action,
    account: account === undefined ? undefined : checkLabel(account),
    stateDir: parseCommandStateDir(rest, io, values[STATE_DIR_FLAG]),
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
 * sync service (`--account`, or the only account). Installing requires a
 * signed-in label and an absolute runtime entry path.
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

  let label: string
  try {
    label = await resolveLabel(command)
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    const host: ServiceHost = io.serviceHost ?? defaultServiceHost()
    const name = serviceName(io.profile ?? PROJECT_PROFILE)
    if (command.action === "install") {
      const paths = await pickLabel(command.stateDir, label)
      if (!(await readAccount(paths))) {
        throw new ToolError("not_found", `Account "${label}" has no verified identity; run login first.`)
      }
      if (!io.entryPath || !isAbsolute(io.entryPath)) {
        throw new ToolError(
          "invalid_argument",
          "Installing the sync service requires an absolute built CLI entry path.",
        )
      }
      await installService(
        {
          ...name,
          label,
          description: `Scheduled account sync (${label})`,
          program: io.program ?? process.execPath,
          args: [io.entryPath, "sync", ACCOUNT_FLAG, label, STATE_DIR_FLAG, command.stateDir],
          path: io.env.PATH ?? "",
        },
        host,
      )
      io.stdout(`Installed sync service for "${label}".\n`)
      io.stdout("Environment-based tokens must be supplied independently to the service environment.\n")
    } else if (command.action === "uninstall") {
      await uninstallService(name, label, host)
      io.stdout(`Uninstalled sync service for "${label}".\n`)
    } else {
      io.stdout(`${statusLines(label, await serviceStatus(name.id, label, host)).join("\n")}\n`)
    }
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "The service command was cancelled." })
  }
}
