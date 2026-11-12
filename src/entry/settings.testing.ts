import { expect } from "bun:test"
import { isToolError } from "../core"
import { PROFILE_OPTIONS } from "./options.testing"
import type { EntryProfile } from "./profile"

/** Fixtures the settings tests share. */

export const profile: EntryProfile = {
  name: "demo-tools",
  cli: "demo-tools-cli",
  serviceId: "io.example.demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta", "gamma"], defaults: ["alpha"] },
  options: PROFILE_OPTIONS,
}

/** What the download and send settings resolve to when nothing sets them. */
export const DEFAULT_DOWNLOADS = { download_dir: expect.any(String), download_max_mb: 100, send_max_mb: 10 }

/** What the package's own settings read as `values` give: the values as the resolved settings, and again as the tool options they were read as. */
export function resolved<T extends object>(values: T): T & { options: T } {
  return { ...values, options: values }
}

export function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}
