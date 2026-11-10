import { ToolError } from "../errors"
import {
  installLaunchdService,
  launchdServiceStatus,
  suspendLaunchdService,
  uninstallLaunchdService,
} from "./service-launchd"
import {
  installSystemdService,
  suspendSystemdService,
  systemdServiceStatus,
  uninstallSystemdService,
} from "./service-systemd"
import {
  defaultServiceHost,
  type ServiceHost,
  type ServiceInstallResult,
  type ServiceName,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

export { defaultServiceHost, SYNC_INTERVAL_SECONDS } from "./service-types"
export type { ServiceHost, ServiceInstallResult, ServiceName, ServiceSpec, ServiceStatus } from "./service-types"

const UNSUPPORTED_PLATFORM = "Running the sync service is supported on macOS and Linux only."

function checkPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ToolError("invalid_argument", UNSUPPORTED_PLATFORM)
  }
}

/**
 * The directory the platform's service manager starts the service in: `/` for a launchd agent, the user's home for
 * a systemd user unit. A program found on the `PATH` can resolve differently from one directory to another, so
 * anything checked for the service must be checked from this directory. Refuses on other platforms.
 */
export function serviceWorkingDirectory(host: ServiceHost = defaultServiceHost()): string {
  checkPlatform(host.platform)
  return host.platform === "darwin" ? "/" : host.home
}

/**
 * Installs and starts the scheduled sync for one label: a launchd agent on macOS, a systemd user timer and
 * service on Linux. Refuses other platforms, and an id, label or spec that is unsafe, before anything is written.
 */
export async function installService(
  spec: ServiceSpec,
  host: ServiceHost = defaultServiceHost(),
): Promise<ServiceInstallResult> {
  checkPlatform(host.platform)
  return host.platform === "darwin" ? installLaunchdService(spec, host) : installSystemdService(spec, host)
}

/** Disables future sync starts, keeping definitions. On launchd the final operation may terminate this run. */
export async function suspendService(
  id: string,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<void> {
  checkPlatform(host.platform)
  return host.platform === "darwin" ? suspendLaunchdService(id, label, host) : suspendSystemdService(id, label, host)
}

/**
 * Stops and deletes the scheduled sync for one label; one that is already gone completes without error. On macOS
 * the launcher script goes too, and its directory once empty.
 */
export async function uninstallService(
  name: ServiceName,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<void> {
  checkPlatform(host.platform)
  return host.platform === "darwin"
    ? uninstallLaunchdService(name, label, host)
    : uninstallSystemdService(name.id, label, host)
}

/** Reads whether the scheduled sync for one label is installed, scheduled and running. */
export async function serviceStatus(
  id: string,
  label: string,
  host: ServiceHost = defaultServiceHost(),
): Promise<ServiceStatus> {
  checkPlatform(host.platform)
  return host.platform === "darwin" ? launchdServiceStatus(id, label, host) : systemdServiceStatus(id, label, host)
}
