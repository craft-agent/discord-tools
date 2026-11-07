import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { ToolError } from "../core/errors"
import { loginAccount } from "../core/discord/client-login"
import { loginFixture } from "../core/discord/client-login.testing"
import { headerOf } from "../core/discord/fake-discord.testing"
import { fakeToken } from "../core/discord/fake-token.testing"
import { PROJECT_PROFILE } from "../entry/profile"
import type { CommandIo } from "./command-io"
import { runCommand } from "./commands.testing"
import { runLoginCommand } from "./login"

let fixture: Awaited<ReturnType<typeof loginFixture>>
beforeEach(async () => {
  fixture = await loginFixture()
})
afterEach(() => fixture.harness.dispose())

function runLogin(
  argv: string[] = [],
  overrides: Partial<CommandIo & { readStdin(): Promise<string> }> = {},
  login: typeof loginAccount = (options) => loginAccount({ ...fixture.options, ...options }),
) {
  return runCommand(
    (args, io) =>
      runLoginCommand(args, { ...io, readStdin: overrides.readStdin ?? (async () => fakeToken()) }, { login }),
    ["--state-dir", fixture.harness.stateDir, ...argv],
    overrides,
  )
}

test("login defaults to default, reports identity/source and never echoes input", async () => {
  const result = await runLogin()
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Signed in "default" as "example" (101); token source: file.')
  expect(result.stderr).toBe("")
  expect(result.stdout + result.stderr).not.toContain(fakeToken())
  expect(await readFile(fixture.harness.paths.token, "utf8")).toBe(fakeToken())
})

test("the profile and account select the variable; environment does not consume stdin", async () => {
  const result = await runLogin(["--account=work"], {
    profile: { ...PROJECT_PROFILE, envPrefix: "EXAMPLE" },
    env: { EXAMPLE_TOKEN_WORK: fakeToken("b") },
    readStdin: async () => {
      throw new Error("must not consume input")
    },
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Signed in "work"')
  expect(result.stdout).toContain("token source: variable")
  expect(headerOf(fixture.harness.discord.api[0]!, "authorization")).toBe(fakeToken("b"))
  expect(existsSync(fixture.harness.paths.token)).toBe(false)
})

test("an empty set environment fails instead of reading stdin", async () => {
  let read = false
  const result = await runLogin([], {
    env: { [`${PROJECT_PROFILE.envPrefix}_TOKEN_DEFAULT`]: "" },
    readStdin: async () => {
      read = true
      return fakeToken()
    },
  })
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(read).toBe(false)
  expect(fixture.harness.discord.requests).toHaveLength(0)
})

test.each([
  { argv: ["--account"] },
  { argv: ["--account", "UPPER"] },
  { argv: ["--unknown"] },
  { argv: ["--token", fakeToken()] },
  { argv: [fakeToken()] },
  { argv: ["--state-dir"] },
])("invalid arguments %j are usage errors before login", async ({ argv }) => {
  let called = false
  const result = await runLogin([...argv], {}, async () => {
    called = true
    throw new Error("must not log in")
  })
  expect(result.code).toBe(2)
  expect(result.stdout).toBe("")
  expect(result.stderr).not.toContain(fakeToken())
  expect(called).toBe(false)
})

test("authentication and identity conflicts are operational failures, not usage errors", async () => {
  fixture.harness.discord.route("GET", "/users/@me", { status: 401, json: { message: fakeToken() } })
  const rejected = await runLogin()
  expect(rejected.code).toBe(1)
  expect(rejected.stderr).not.toContain(fakeToken())
  const conflict = await runLogin([], {}, async () => {
    throw new ToolError("invalid_argument", "This label belongs to another account.")
  })
  expect(conflict.code).toBe(1)
  expect(conflict.stderr).toContain("another account")
})

test("input failures are sanitized before the handler prints them", async () => {
  const secret = fakeToken().replaceAll(".", "-")
  const result = await runLogin([], {
    readStdin: async () => {
      throw new ToolError("invalid_argument", secret, { cause: new Error(secret) })
    },
  })
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).not.toContain(secret)
  expect(result.stderr).toContain("Could not read the login input")
})

test("the handler forwards cancellation without reading input or sending requests", async () => {
  const controller = new AbortController()
  const secret = fakeToken().replaceAll(".", "-")
  controller.abort(new ToolError("invalid_argument", secret))
  const result = await runLogin([], {
    signal: controller.signal,
    readStdin: async () => {
      throw new Error("must not read input")
    },
  })
  expect(result.code).toBe(1)
  expect(result.stderr).not.toContain(secret)
  expect(result.stderr).toContain("Login was cancelled.")
  expect(fixture.harness.discord.requests).toHaveLength(0)
})
