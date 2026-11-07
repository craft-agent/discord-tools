import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { discordAccountRead } from "../core/account/read"
import {
  expectEmptyAccountState,
  expectSignedInAccount,
  withAccountState,
  type AccountFixture,
} from "../entry/account.testing"
import { call, connect, runCleanups, settings, textOf } from "./testing"

afterEach(runCleanups)

async function readAccount(fixture: AccountFixture, args: Record<string, unknown> = {}) {
  const { client, elicited, logs } = await connect(
    [discordAccountRead],
    settings({ state_dir: fixture.stateDir, read_only: true, confirm: "elicitation" }),
    { capabilities: { elicitation: { form: {} } }, failElicitation: true },
    { ...fixture.options, toolsets: undefined },
  )
  const listed = (await client.listTools()).tools
  expect(listed.map((tool) => tool.name)).toEqual([discordAccountRead.id])
  expect(listed[0]!.annotations?.readOnlyHint).toBe(true)
  const result = await call(client, discordAccountRead.id, args)
  expect(elicited).toEqual([])
  expect(logs).toEqual([])
  return result
}

describe("MCP account read", () => {
  for (const state of ["missing", "empty"]) {
    test(`returns no accounts for ${state} state without creating anything`, async () => {
      await withAccountState(async (fixture) => {
        if (state === "empty") await mkdir(fixture.stateDir)
        const result = await readAccount(fixture)
        expect(result.isError).toBeUndefined()
        expect(result.structuredContent).toEqual({ accounts: [] })
        expect(JSON.parse(textOf(result))).toEqual(result.structuredContent)
        await expectEmptyAccountState(fixture, state === "empty")
      })
    })
  }

  test("returns the signed-in identity with injected credential and recovery settings", async () => {
    await withAccountState(async (fixture) => {
      await fixture.signIn()
      const result = await readAccount(fixture)
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent)
      await expectSignedInAccount(result.structuredContent, fixture)
    })
  })

  test("refuses unknown arguments before inspecting state or the scheduler", async () => {
    await withAccountState(async (fixture) => {
      const result = await readAccount(fixture, { unexpected: true })
      expect(result.isError).toBe(true)
      expect(JSON.parse(textOf(result)).error.code).toBe("invalid_argument")
      await expectEmptyAccountState(fixture, false)
    })
  })
})
