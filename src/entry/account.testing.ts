import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { writeAccount } from "../core/discord/account-meta"
import { fakeToken } from "../core/discord/fake-token.testing"
import { ensureLabelDir } from "../core/discord/labels"
import { failed, fakeHost, withHome } from "../core/discord/service.testing"
import type { EntryProfile } from "./profile"
import type { RuntimeOptions } from "./runtime"

/** An injected identity whose defaults select the real account tool. */
export const ACCOUNT_PROFILE: EntryProfile = {
  name: "example-account-tools",
  cli: "example-account-cli",
  serviceId: "io.example.account-test",
  envPrefix: "EXAMPLE",
  toolsets: { names: ["account"], defaults: ["account"] },
}

/** Isolated state and scheduler dependencies shared by the adapter integration tests. */
export type AccountFixture = {
  stateDir: string
  options: Required<RuntimeOptions>
  calls: string[][]
  signIn: () => Promise<void>
  recoveryCommand: string
}

/** Provides a missing state root and fake scheduler, removing all state even if a test fails. */
export async function withAccountState(body: (fixture: AccountFixture) => Promise<void>): Promise<void> {
  await withHome(async (home) => {
    const stateDir = join(home, "account's state")
    const { host, calls } = fakeHost("darwin", home, () => failed(113, "Could not find service"))
    const env: Record<string, string | undefined> = {}
    const now = () => 1_800_000_000_000
    await body({
      stateDir,
      options: { profile: ACCOUNT_PROFILE, env, serviceHost: host, now },
      calls,
      async signIn() {
        const paths = await ensureLabelDir(stateDir, "work")
        await writeAccount(paths, { id: "101234567890123456", name: "Example User", verifiedAt: now() })
        env.EXAMPLE_TOKEN_WORK = fakeToken()
      },
      recoveryCommand: `'example-account-cli' sync --account 'work' --state-dir '${home}/account'\\''s state'`,
    })
  })
}

/** Empty reads neither initialize state nor consult the scheduler. */
export async function expectEmptyAccountState(fixture: AccountFixture, present: boolean): Promise<void> {
  expect(fixture.calls).toEqual([])
  expect(existsSync(fixture.stateDir)).toBe(present)
  if (present) expect(await readdir(fixture.stateDir)).toEqual([])
}

/** Checks identity, credential metadata, injected recovery guidance and read-only manager access. */
export async function expectSignedInAccount(output: unknown, fixture: AccountFixture): Promise<void> {
  expect(output).toMatchObject({
    accounts: [
      {
        label: "work",
        id: "101234567890123456",
        name: "Example User",
        token_source: "variable",
        token_status: "available",
        token_rejected_at: null,
        installed: false,
        scheduled: false,
        running: false,
        action: "sync",
        recovery_command: fixture.recoveryCommand,
      },
    ],
  })
  expect(JSON.stringify(output)).not.toContain(fakeToken())
  expect(fixture.calls).toEqual([["launchctl", "print", "gui/501/io.example.account-test.work"]])
  expect(await readdir(join(fixture.stateDir, "work"))).toEqual(["account.json"])
}
