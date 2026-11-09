import { expect } from "bun:test"
import { isToolError } from "../core"
import type { EntryProfile } from "./profile"

/** Fixtures the settings tests share. */

export const profile: EntryProfile = {
  name: "demo-tools",
  cli: "demo-tools-cli",
  serviceId: "io.example.demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta", "gamma"], defaults: ["alpha"] },
}

/** What the download settings resolve to when nothing sets them. */
export const DEFAULT_DOWNLOADS = { download_dir: expect.any(String), download_max_mb: 100 }

export function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}
