import type { DiscordClientOptions } from "./discord/client"
import type { ServiceHost } from "./discord/service"

/** The identity and runtime dependencies an entry point supplies to a tool. */
export type ToolRuntime = {
  envPrefix: string
  cli: string
  serviceId: string
  env: Record<string, string | undefined>
  serviceHost: ServiceHost
  now: () => number
  /** Test and entry-point overrides for the one HTTP client; production leaves it unset. */
  discord?: Pick<DiscordClientOptions, "transport" | "download" | "os" | "sleep" | "random">
}
