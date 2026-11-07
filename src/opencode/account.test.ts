import { describe, expect, mock, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { discordAccountRead } from "../core/account/read"
import {
  expectEmptyAccountState,
  expectSignedInAccount,
  withAccountState,
  type AccountFixture,
} from "../entry/account.testing"
import type { V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

async function setUp(fixture: AccountFixture, version: "V1" | "V2") {
  const approve = mock(async () => {
    throw new Error("An account read must not ask for approval")
  })
  const options = { state_dir: fixture.stateDir, read_only: true }
  const directory = fixture.options.serviceHost.home
  const signal = new AbortController().signal
  if (version === "V1") {
    const { tool } = await createV1Server([discordAccountRead], fixture.options)({}, options)
    expect(Object.keys(tool)).toEqual([discordAccountRead.id])
    return {
      approve,
      async read(args: Record<string, unknown> = {}) {
        const result = await tool[discordAccountRead.id]!.execute(args, {
          directory,
          worktree: directory,
          abort: signal,
          ask: approve,
        })
        return JSON.parse(result)
      },
    }
  }
  const tools = new Map<string, V2Tool>()
  await createV2Setup(
    [discordAccountRead],
    fixture.options,
  )({
    options,
    session: { get: async () => ({ location: { directory } }) },
    permission: { assert: approve },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  })
  expect([...tools.keys()]).toEqual([discordAccountRead.id])
  return {
    approve,
    async read(args: Record<string, unknown> = {}) {
      const result = await tools.get(discordAccountRead.id)!.execute(args, { sessionID: "ses_account", signal })
      expect(JSON.parse(result.content)).toEqual(result.output)
      return result.output
    },
  }
}

for (const version of ["V1", "V2"] as const) {
  describe(`OpenCode ${version} account read`, () => {
    for (const state of ["missing", "empty"]) {
      test(`returns no accounts for ${state} state without creating anything`, async () => {
        await withAccountState(async (fixture) => {
          if (state === "empty") await mkdir(fixture.stateDir)
          const adapter = await setUp(fixture, version)
          expect(await adapter.read()).toEqual({ accounts: [] })
          expect(adapter.approve).not.toHaveBeenCalled()
          await expectEmptyAccountState(fixture, state === "empty")
        })
      })
    }

    test("returns the signed-in identity with injected credential and recovery settings", async () => {
      await withAccountState(async (fixture) => {
        await fixture.signIn()
        const adapter = await setUp(fixture, version)
        await expectSignedInAccount(await adapter.read(), fixture)
        expect(adapter.approve).not.toHaveBeenCalled()
      })
    })

    test("refuses unknown arguments before inspecting state or the scheduler", async () => {
      await withAccountState(async (fixture) => {
        const adapter = await setUp(fixture, version)
        await expect(adapter.read({ unexpected: true })).rejects.toThrow("invalid_argument")
        expect(adapter.approve).not.toHaveBeenCalled()
        await expectEmptyAccountState(fixture, false)
      })
    })
  })
}
