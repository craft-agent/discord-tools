import { mkdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import {
  checkServiceSpec,
  checkServiceTarget,
  isFile,
  isKnownAbsent,
  mapProgramError,
  removeFile,
  runSucceeded,
  SYNC_INTERVAL_SECONDS,
  writeDefinitionFile,
  type ServiceHost,
  type ServiceInstallResult,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

/** What `systemctl` says about a unit it does not have, after the unit's name. */
const ABSENT_DIAGNOSTIC = "(?:not loaded|does not exist|could not be found|not found)"

/** What `systemctl show` prints for a unit it does not have. */
const NOT_FOUND_LOAD_STATE = /^LoadState=not-found$/m

/** The `LoadState` of a unit that does not exist. */
const NOT_FOUND = "not-found"

/** A diagnostic naming `unitName` as absent, such as `Unit x.timer not loaded.` or `Unit file x.timer does not exist.`. */
function absentUnitText(unitName: string): RegExp {
  const name = unitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\bUnit (?:file )?${name} ${ABSENT_DIAGNOSTIC}\\b`, "i")
}

/** The properties `systemctl show` is asked for. */
const SHOW_PROPERTIES = ["LoadState", "ActiveState", "MainPID", "ExecMainStatus", "ExecMainStartTimestampMonotonic"]

/** The `ActiveState` values of a service with a run in progress. */
const RUNNING_STATES = ["activating", "active"]

/** Escapes `\`, `"` and the specifier character `%`, for text inside double quotes. */
function escapeQuoted(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")
}

/** Quotes an argument for `ExecStart`: escapes `\`, `"`, `%` as `%%` and `$` as `$$`. */
export function quoteSystemdArg(arg: string): string {
  return `"${escapeQuoted(arg).replaceAll("$", () => "$$")}"`
}

/** Builds the oneshot service unit: one sync run per start, never restarted. */
export function buildSystemdService(spec: ServiceSpec): string {
  const execStart = [spec.program, ...spec.args].map(quoteSystemdArg).join(" ")
  return `[Unit]
Description=${spec.description.replaceAll("%", "%%")}

[Service]
Type=oneshot
ExecStart=${execStart}
Environment="PATH=${escapeQuoted(spec.path)}"
`
}

/** Builds the timer unit that starts the service shortly after it is enabled and then every `SYNC_INTERVAL_SECONDS`. */
export function buildSystemdTimer(spec: ServiceSpec, serviceName: string): string {
  return `[Unit]
Description=${spec.description.replaceAll("%", "%%")}

[Timer]
OnStartupSec=1s
OnUnitActiveSec=${SYNC_INTERVAL_SECONDS}s
AccuracySec=1s
Unit=${serviceName}

[Install]
WantedBy=timers.target
`
}

function systemdPaths(id: string, label: string, host: ServiceHost) {
  const baseName = `${id.replaceAll(".", "-")}-${label}`
  const serviceName = `${baseName}.service`
  const timerName = `${baseName}.timer`
  const configured = host.env.XDG_CONFIG_HOME
  const configHome = configured && isAbsolute(configured) ? configured : join(host.home, ".config")
  const unitDir = join(configHome, "systemd", "user")
  return {
    serviceName,
    timerName,
    unitDir,
    servicePath: join(unitDir, serviceName),
    timerPath: join(unitDir, timerName),
    log: `journalctl --user -u ${serviceName}`,
  }
}

async function systemctl(host: ServiceHost, ...args: string[]): Promise<void> {
  const result = await host.run(["systemctl", "--user", ...args])
  if (!runSucceeded(result)) throw mapProgramError("systemctl", result)
}

/** Runs a `systemctl` command on `unitName`, tolerating only a diagnostic that says that unit is not there. */
async function systemctlIfPresent(host: ServiceHost, unitName: string, ...args: string[]): Promise<void> {
  const result = await host.run(["systemctl", "--user", ...args, unitName])
  if (runSucceeded(result) || isKnownAbsent(result, absentUnitText(unitName))) return
  throw mapProgramError("systemctl", result)
}

/** The properties of one unit; an absent unit reports `LoadState=not-found`. */
async function showUnit(host: ServiceHost, unitName: string): Promise<Record<string, string>> {
  const argv = ["systemctl", "--user", "show", unitName, ...SHOW_PROPERTIES.flatMap((name) => ["-p", name])]
  const result = await host.run(argv)
  const absent = isKnownAbsent(result, absentUnitText(unitName)) || isKnownAbsent(result, NOT_FOUND_LOAD_STATE)
  if (absent) return { LoadState: NOT_FOUND }
  if (!runSucceeded(result)) throw mapProgramError("systemctl", result)

  const properties: Record<string, string> = {}
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("=")
    if (separator !== -1) properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return properties
}

function positiveInteger(text: string | undefined): number | undefined {
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Writes the service and timer units and starts the timer. */
export async function installSystemdService(spec: ServiceSpec, host: ServiceHost): Promise<ServiceInstallResult> {
  checkServiceSpec(spec, host.home)
  const { serviceName, timerName, unitDir, servicePath, timerPath, log } = systemdPaths(spec.id, spec.label, host)

  await mkdir(unitDir, { recursive: true })
  await writeDefinitionFile(servicePath, buildSystemdService(spec))
  await writeDefinitionFile(timerPath, buildSystemdTimer(spec, serviceName))

  await systemctl(host, "daemon-reload")
  await systemctl(host, "enable", "--now", timerName)

  return { file: servicePath, timer: timerPath, log }
}

/** Disables future timer starts, keeping both units and allowing the current service run to finish. */
export async function suspendSystemdService(id: string, label: string, host: ServiceHost): Promise<void> {
  checkServiceTarget(id, label, host.home)
  const { timerName } = systemdPaths(id, label, host)
  await systemctlIfPresent(host, timerName, "disable", "--now")
}

/** Stops the timer and service and deletes both units; units that are not there are fine, any other failure leaves the files. */
export async function uninstallSystemdService(id: string, label: string, host: ServiceHost): Promise<void> {
  checkServiceTarget(id, label, host.home)
  const { serviceName, timerName, servicePath, timerPath } = systemdPaths(id, label, host)

  await systemctlIfPresent(host, timerName, "disable", "--now")
  await systemctlIfPresent(host, serviceName, "stop")
  await removeFile(timerPath)
  await removeFile(servicePath)
  await systemctl(host, "daemon-reload")
}

/** Reads the state of the timer and the service it starts. */
export async function systemdServiceStatus(id: string, label: string, host: ServiceHost): Promise<ServiceStatus> {
  checkServiceTarget(id, label, host.home)
  const { serviceName, timerName, servicePath, timerPath, log } = systemdPaths(id, label, host)

  const serviceFile = await isFile(servicePath)
  const timerFile = await isFile(timerPath)
  const installed = serviceFile && timerFile
  const base = { file: servicePath, timer: timerPath, log }

  const timer = await showUnit(host, timerName)
  const service = await showUnit(host, serviceName)

  const scheduled = timer.LoadState !== NOT_FOUND && timer.ActiveState === "active"
  const pid = positiveInteger(service.MainPID)
  const running = service.LoadState !== NOT_FOUND && RUNNING_STATES.includes(service.ActiveState ?? "") && !!pid
  const hasRunBefore = Number(service.ExecMainStartTimestampMonotonic) > 0
  const exit = Number(service.ExecMainStatus)
  const lastExit =
    service.LoadState !== NOT_FOUND &&
    !running &&
    hasRunBefore &&
    service.ExecMainStatus !== "" &&
    Number.isInteger(exit)
      ? exit
      : undefined

  return { installed, scheduled, running, pid: running ? pid : undefined, lastExit, ...base }
}
