import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecResult } from "../exec"
import type { ServiceHost, ServiceSpec } from "./service-types"

/** A spec with made-up names, as an entry point would pass one. */
export const SPEC: ServiceSpec = {
  id: "io.example.tools",
  launcher: "example-sync",
  label: "default",
  description: "Example sync service",
  program: "/usr/bin/node",
  args: ["/opt/tools/cli.js", "sync"],
  path: "/usr/bin:/bin",
}

/** An `ExecResult` that succeeded with `stdout`. */
export function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" }
}

/** An `ExecResult` that failed with `code` and `stderr`. */
export function failed(code: number, stderr: string): ExecResult {
  return { code, stdout: "", stderr }
}

/** A fake host that records every command and answers through `answer` (success when it returns nothing). */
export function fakeHost(
  platform: NodeJS.Platform,
  home: string,
  answer: (argv: string[]) => ExecResult | undefined = () => undefined,
): { host: ServiceHost; calls: string[][] } {
  const calls: string[][] = []
  const host: ServiceHost = {
    platform,
    home,
    uid: 501,
    env: { PATH: "/usr/bin:/bin" },
    run: async (argv) => {
      calls.push(argv)
      return answer(argv) ?? ok()
    },
  }
  return { host, calls }
}

/** Runs `body` with a temporary home directory that is removed afterwards. */
export async function withHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "svc-"))
  try {
    await body(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
