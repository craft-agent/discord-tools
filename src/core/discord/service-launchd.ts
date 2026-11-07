import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
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

/** The exit codes `launchctl` gives for a job that is not registered. */
const ABSENT_CODES = [3, 113] as const

/** What `launchctl` says for a job that is not registered. */
const ABSENT_TEXT = /could not find service|no such process|not loaded/i

/** Mode of the log directory: owner only. */
const LOG_DIR_MODE = 0o700

/** Escapes the characters that are special in XML text. */
export function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/** Builds the launchd property list: one run at load and then every `SYNC_INTERVAL_SECONDS`, never kept alive. */
export function buildLaunchdPlist(spec: ServiceSpec, logPath: string): string {
  const agentLabel = `${spec.id}.${spec.label}`
  const argsXml = [spec.program, ...spec.args].map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`).join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(agentLabel)}</string>
\t<key>ProgramArguments</key>
\t<array>
${argsXml}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(spec.path)}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartInterval</key>
\t<integer>${SYNC_INTERVAL_SECONDS}</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

function launchdPaths(id: string, label: string, host: ServiceHost) {
  const agentLabel = `${id}.${label}`
  const logDir = join(host.home, "Library", "Logs", id)
  return {
    agentLabel,
    target: `gui/${host.uid}/${agentLabel}`,
    plistPath: join(host.home, "Library", "LaunchAgents", `${agentLabel}.plist`),
    logDir,
    logPath: join(logDir, `${label}.log`),
  }
}

/** Unloads the job; true when it was loaded, false when it was not, and throws on any other failure. */
async function bootout(target: string, host: ServiceHost): Promise<boolean> {
  const result = await host.run(["launchctl", "bootout", target])
  if (runSucceeded(result)) return true
  if (isKnownAbsent(result, ABSENT_TEXT, ABSENT_CODES)) return false
  throw mapProgramError("launchctl", result)
}

/** What `launchctl print` says about the job, or `undefined` when it is not registered. */
async function printJob(target: string, host: ServiceHost): Promise<string | undefined> {
  const result = await host.run(["launchctl", "print", target])
  if (runSucceeded(result)) return result.stdout
  if (isKnownAbsent(result, ABSENT_TEXT, ABSENT_CODES)) return undefined
  throw mapProgramError("launchctl", result)
}

/** Writes the launchd agent and loads it, replacing a loaded earlier one. */
export async function installLaunchdService(spec: ServiceSpec, host: ServiceHost): Promise<ServiceInstallResult> {
  checkServiceSpec(spec, host.home)
  const { target, plistPath, logDir, logPath } = launchdPaths(spec.id, spec.label, host)

  await bootout(target, host)

  await mkdir(logDir, { recursive: true, mode: LOG_DIR_MODE })
  await chmod(logDir, LOG_DIR_MODE)
  await mkdir(dirname(plistPath), { recursive: true })
  await writeDefinitionFile(plistPath, buildLaunchdPlist(spec, logPath))

  const enabled = await host.run(["launchctl", "enable", target])
  if (!runSucceeded(enabled)) throw mapProgramError("launchctl", enabled)
  const result = await host.run(["launchctl", "bootstrap", `gui/${host.uid}`, plistPath])
  if (!runSucceeded(result)) throw mapProgramError("launchctl", result)

  return { file: plistPath, log: logPath }
}

/** Persists a disabled job before unloading it; bootout may terminate this process, so no cleanup follows it. */
export async function suspendLaunchdService(id: string, label: string, host: ServiceHost): Promise<void> {
  checkServiceTarget(id, label, host.home)
  const { target } = launchdPaths(id, label, host)
  const result = await host.run(["launchctl", "disable", target])
  if (!runSucceeded(result)) throw mapProgramError("launchctl", result)
  await bootout(target, host)
}

/** Unloads the agent and deletes its plist; an agent that is not loaded or not there is fine, any other failure leaves the plist. */
export async function uninstallLaunchdService(id: string, label: string, host: ServiceHost): Promise<void> {
  checkServiceTarget(id, label, host.home)
  const { target, plistPath } = launchdPaths(id, label, host)

  await bootout(target, host)
  await removeFile(plistPath)
}

/** Reads the agent's state from its plist and `launchctl print`. */
export async function launchdServiceStatus(id: string, label: string, host: ServiceHost): Promise<ServiceStatus> {
  checkServiceTarget(id, label, host.home)
  const { target, plistPath, logPath } = launchdPaths(id, label, host)

  const installed = await isFile(plistPath)
  const output = await printJob(target, host)
  if (output === undefined) {
    return { installed, scheduled: false, running: false, file: plistPath, log: logPath }
  }

  const running = /\bstate\s*=\s*running\b/i.test(output)
  const pid = running ? Number(output.match(/\bpid\s*=\s*(\d+)/i)?.[1]) || undefined : undefined
  const exit = output.match(/\blast exit code\s*=\s*(-?\d+)/i)?.[1]
  const lastExit = exit === undefined ? undefined : Number(exit)

  return { installed, scheduled: true, running, pid, lastExit, file: plistPath, log: logPath }
}
