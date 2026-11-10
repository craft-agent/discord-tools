import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "bun:test"
import { ensureLabelDir } from "../core/discord/labels"
import type { ServiceHost } from "../core/discord/service"
import type { CommandIo } from "./command-io"

/** Fixtures the tests of the account-management commands share. */

/** A token-shaped text that belongs to no account, for the files a removal must delete. */
export const FAKE_TOKEN_FILE_TEXT = "made-up-token-for-tests"

/** A service host that records what it is asked to run and never touches the machine. */
export type FakeHost = ServiceHost & { calls: string[][] }

/**
 * A macOS-like host whose commands all succeed silently, unless `overrides` say otherwise. It never sleeps, and once a
 * `launchctl bootout` has succeeded it answers `launchctl print` with not-found until the next `bootstrap`, as launchd
 * does once the job is gone.
 */
export function fakeHost(home: string, overrides: Partial<ServiceHost> = {}): FakeHost {
  const calls: string[][] = []
  let bootedOut = false
  return {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/bin" },
    sleep: async () => {},
    ...overrides,
    run: async (argv: string[]) => {
      calls.push(argv)
      if (argv[1] === "print" && bootedOut) return { code: 113, stdout: "", stderr: "Could not find service" }
      const result = overrides.run ? await overrides.run(argv) : { code: 0, stdout: "", stderr: "" }
      if (argv[1] === "bootout" && result.code === 0) bootedOut = true
      if (argv[1] === "bootstrap") bootedOut = false
      return result
    },
    calls,
  }
}

/** A host that fails every program it runs, as a manager that refuses. */
export function refusingHost(home: string, stderr: string): FakeHost {
  return fakeHost(home, {
    run: async () => ({ code: 1, stdout: "", stderr }),
  })
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A fresh temporary state directory, removed after the test. */
export async function tempStateDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "cmd-")))
  directories.push(dir)
  return dir
}

/** Creates the account's directory with a token file in it, as a signed-in account has. */
export async function signedInAccount(stateDir: string, label: string): Promise<string> {
  const paths = await ensureLabelDir(stateDir, label)
  await writeFile(paths.token, FAKE_TOKEN_FILE_TEXT)
  return paths.dir
}

export type CommandRun = { code: number; stdout: string; stderr: string }

/** Runs a command over a collecting `CommandIo`; `overrides` replace any part of it. */
export async function runCommand(
  command: (argv: string[], io: CommandIo) => Promise<number>,
  argv: string[],
  overrides: Partial<CommandIo> = {},
): Promise<CommandRun> {
  let stdout = ""
  let stderr = ""
  const code = await command(argv, {
    env: {},
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...overrides,
  })
  return { code, stdout, stderr }
}
