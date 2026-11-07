import type { ToolRuntime } from "../core"
import { defaultServiceHost, type ServiceHost } from "../core/discord/service"
import { PROJECT_PROFILE, type EntryProfile } from "./profile"

/** Optional replacements for the identity and runtime dependencies of an entry point. */
export type RuntimeOptions = {
  profile?: EntryProfile
  env?: Record<string, string | undefined>
  serviceHost?: ServiceHost
  now?: () => number
}

/** Wires runtime dependencies without reading account state or querying the scheduler. */
export function createToolRuntime(options: RuntimeOptions = {}): ToolRuntime {
  const profile = options.profile ?? PROJECT_PROFILE
  return {
    envPrefix: profile.envPrefix,
    cli: profile.cli,
    serviceId: profile.serviceId,
    env: options.env ?? process.env,
    serviceHost: options.serviceHost ?? defaultServiceHost(),
    now: options.now ?? Date.now,
  }
}
