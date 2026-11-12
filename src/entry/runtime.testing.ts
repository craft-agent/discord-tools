import { mock } from "bun:test"
import type { ServiceHost } from "../core/discord/service"
import type { RuntimeOptions } from "./runtime"
import { profile } from "./settings.testing"

/** Offline runtime dependencies: inspecting account state or the host during wiring fails the test. */
export function runtimeFixture(): Required<RuntimeOptions> {
  const env: Record<string, string | undefined> = {
    DEMO_STATE_DIR: "/runtime/state",
    DEMO_DOWNLOAD_DIR: "/runtime/downloads",
    DEMO_DOWNLOAD_MAX_MB: "42",
    DEMO_SEND_DIRS: "/runtime/send1,/runtime/send2",
    DEMO_SEND_MAX_MB: "15",
  }
  const serviceHost: ServiceHost = new Proxy({} as ServiceHost, {
    get: () => {
      throw new Error("runtime wiring must not inspect the scheduler")
    },
  })
  return { profile, env, serviceHost, now: mock(() => 123456) }
}
