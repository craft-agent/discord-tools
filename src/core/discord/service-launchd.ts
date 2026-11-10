import { chmod, lstat, mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import {
  checkLauncherName,
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
  type ServiceName,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

/** The exit codes `launchctl` gives for a job that is not registered. */
const ABSENT_CODES = [3, 113] as const

/** What `launchctl` says for a job that is not registered. */
const ABSENT_TEXT = /could not find service|no such process|not loaded/i

/** Mode of the log directory: owner only. */
const LOG_DIR_MODE = 0o700

/** Mode of the launcher directory: owner only. */
const LAUNCHER_DIR_MODE = 0o700

/** Mode of the launcher script. */
const LAUNCHER_MODE = 0o755

/** Hands over to the program and arguments after it, so the agent is listed under the script's own name. */
export const LAUNCHER_SCRIPT = '#!/bin/sh\nexec "$@"\n'

/** Escapes the characters that are special in XML text. */
export function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/**
 * Builds the launchd property list: one run at load and then every `SYNC_INTERVAL_SECONDS`, never kept alive. The
 * program starts through the launcher script.
 */
export function buildLaunchdPlist(spec: ServiceSpec, logPath: string, launcherPath: string): string {
  const agentLabel = `${spec.id}.${spec.label}`
  const argsXml = [launcherPath, spec.program, ...spec.args]
    .map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`)
    .join("\n")

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

function launcherPaths(id: string, label: string, launcher: string, host: ServiceHost) {
  const launcherDir = join(host.home, "Library", "Application Support", id)
  return { launcherDir, launcherPath: join(launcherDir, `${launcher}-${label}`) }
}

/**
 * Writes the launcher script, renamed into place from a staging file so a running agent never finds it missing and
 * a link at its path is replaced, never followed.
 */
async function writeLauncher(launcherDir: string, launcherPath: string): Promise<void> {
  await mkdir(launcherDir, { recursive: true, mode: LAUNCHER_DIR_MODE })
  await chmod(launcherDir, LAUNCHER_DIR_MODE)
  const staging = join(launcherDir, `.${basename(launcherPath)}.tmp`)
  await removeFile(staging)
  await writeFile(staging, LAUNCHER_SCRIPT, { encoding: "utf8", mode: LAUNCHER_MODE, flag: "wx" })
  await chmod(staging, LAUNCHER_MODE)
  await rename(staging, launcherPath)
}

/**
 * Deletes `path` when it is a regular file, never following a link, then `dir` when nothing else is in it.
 * Whatever cannot be tidied is left alone.
 */
async function removeFileThenEmptyDir(path: string, dir: string): Promise<void> {
  try {
    if ((await lstat(path)).isFile()) await unlink(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }

  try {
    await rmdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT" && code !== "ENOTDIR") throw error
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

/** Writes the launcher script and the launchd agent and loads it, replacing a loaded earlier one. */
export async function installLaunchdService(spec: ServiceSpec, host: ServiceHost): Promise<ServiceInstallResult> {
  checkServiceSpec(spec, host.home)
  checkLauncherName(spec.launcher)
  const { target, plistPath, logDir, logPath } = launchdPaths(spec.id, spec.label, host)
  const { launcherDir, launcherPath } = launcherPaths(spec.id, spec.label, spec.launcher, host)

  await bootout(target, host)

  await mkdir(logDir, { recursive: true, mode: LOG_DIR_MODE })
  await chmod(logDir, LOG_DIR_MODE)
  await writeLauncher(launcherDir, launcherPath)
  await mkdir(dirname(plistPath), { recursive: true })
  await writeDefinitionFile(plistPath, buildLaunchdPlist(spec, logPath, launcherPath))

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

/**
 * Unloads the agent and deletes its plist, then its launcher script and the launcher's directory once empty; an agent
 * that is not loaded or not there is fine, any other failure leaves the plist. The launcher name is checked only once
 * the agent is gone: a caller that reads a refusal as "no service here" must not leave a loaded agent behind.
 */
export async function uninstallLaunchdService(name: ServiceName, label: string, host: ServiceHost): Promise<void> {
  checkServiceTarget(name.id, label, host.home)
  const { target, plistPath } = launchdPaths(name.id, label, host)

  await bootout(target, host)
  await removeFile(plistPath)

  checkLauncherName(name.launcher)
  const { launcherDir, launcherPath } = launcherPaths(name.id, label, name.launcher, host)
  await removeFileThenEmptyDir(launcherPath, launcherDir)
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
