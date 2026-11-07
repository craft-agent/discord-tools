import { describe, expect, mock, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { discordAccountRead } from "../core/account/read"
import {
  expectEmptyAccountState,
  expectSignedInAccount,
  withAccountState,
  type AccountFixture,
} from "../entry/account.testing"
import { EXIT_FAILED, EXIT_OK } from "./cli"
import { cli, json } from "./testing"

async function readAccount(fixture: AccountFixture, args: Record<string, unknown> = {}) {
  const readLine = mock(async () => {
    throw new Error("An account read must not ask for approval")
  })
  const run = await cli(
    [
      "run",
      discordAccountRead.id,
      "--cwd",
      fixture.options.serviceHost.home,
      "--state-dir",
      fixture.stateDir,
      "--read-only",
    ],
    JSON.stringify(args),
    { ...fixture.options, specs: [discordAccountRead], readLine },
  )
  expect(readLine).not.toHaveBeenCalled()
  expect(run.stderr).toBe("")
  return run
}

describe("CLI account read", () => {
  for (const state of ["missing", "empty"]) {
    test(`returns no accounts for ${state} state without creating anything`, async () => {
      await withAccountState(async (fixture) => {
        if (state === "empty") await mkdir(fixture.stateDir)
        const run = await readAccount(fixture)
        expect(run.code).toBe(EXIT_OK)
        expect(json(run)).toEqual({ result: { accounts: [] } })
        await expectEmptyAccountState(fixture, state === "empty")
      })
    })
  }

  test("returns the signed-in identity with injected credential and recovery settings", async () => {
    await withAccountState(async (fixture) => {
      await fixture.signIn()
      const run = await readAccount(fixture)
      expect(run.code).toBe(EXIT_OK)
      await expectSignedInAccount(json(run).result, fixture)
    })
  })

  test("refuses unknown arguments before inspecting state or the scheduler", async () => {
    await withAccountState(async (fixture) => {
      const run = await readAccount(fixture, { unexpected: true })
      expect(run.code).toBe(EXIT_FAILED)
      expect(json(run).error.code).toBe("invalid_argument")
      await expectEmptyAccountState(fixture, false)
    })
  })
})
