import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { ToolError, abortError } from "../core"
import type { DiscordClientOptions, GatewayReady } from "../core/discord/client"
import { GATEWAY_READY_TIMEOUT_MS } from "../core/discord/client"
import { fakeToken } from "../core/discord/fake-token.testing"
import { labelPaths } from "../core/discord/labels"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runCommand, signedInAccount, tempStateDir } from "./commands.testing"
import { type GatewayCheckDeps, runGatewayCheckCommand } from "./gateway-check"
import { PROFILE, cli } from "./testing"

const TOKEN = fakeToken()
const READY: GatewayReady = {
  userId: "123",
  readStates: [
    { channel: "1", lastRead: "10", mentions: 2, flags: 0 },
    { channel: "2", lastRead: null, mentions: 0, flags: 0 },
  ],
  partial: false,
  ms: 812,
}

type Fixture = {
  deps: GatewayCheckDeps
  options: DiscordClientOptions[]
  calls: { timeoutMs: number }[]
  sleeps: number[]
}

/** Fake clock and client: each `gatewayReady` answers from `answer(round)`; nothing waits. */
function fixture(answer: (round: number) => Promise<GatewayReady> | GatewayReady = () => READY): Fixture {
  const options: DiscordClientOptions[] = []
  const calls: { timeoutMs: number }[] = []
  const sleeps: number[] = []
  return {
    options,
    calls,
    sleeps,
    deps: {
      createClient: (given) => {
        options.push(given)
        return {
          gatewayReady: async (call) => {
            calls.push(call)
            return answer(calls.length)
          },
        }
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      now: () => new Date(2026, 10, 11, 9, 5, 7),
    },
  }
}

async function run(argv: string[], deps: GatewayCheckDeps, overrides: Partial<CommandIo> = {}) {
  return runCommand((args, io) => runGatewayCheckCommand(args, io, deps), argv, { profile: PROFILE, ...overrides })
}

describe("gateway-check command", () => {
  test("opens five sessions thirty seconds apart by default and says what happened", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const fake = fixture()
    const env = { DEMO_TOKEN_WORK: TOKEN }
    const signal = new AbortController().signal
    const result = await run(["--state-dir", dir], fake.deps, { env, signal })

    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toBe("")
    expect(fake.options).toEqual([
      { stateDir: dir, paths: labelPaths(dir, "work"), tokenVariable: "DEMO_TOKEN_WORK", env },
    ])
    expect(fake.calls).toEqual(Array(5).fill({ timeoutMs: GATEWAY_READY_TIMEOUT_MS, signal }))
    expect(fake.sleeps).toEqual([30_000, 30_000, 30_000, 30_000])
    const rounds = result.stdout.split("\n").filter((line) => line.startsWith("Round "))
    expect(rounds).toEqual(
      [1, 2, 3, 4, 5].map(
        (n) => `Round ${n}/5 at 2026-11-11 09:05:07: READY after 812 ms, 2 read states, partial: no; session closed.`,
      ),
    )
    expect(result.stdout).toContain("Done: 5 sessions opened and closed.")
  })

  test("states the procedure first and what to record afterwards", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const result = await run(["--state-dir", dir], fixture().deps)
    const text = result.stdout
    expect(text.indexOf("Close every other Discord client")).toBeGreaterThan(-1)
    expect(text.indexOf("Close every other Discord client")).toBeLessThan(text.indexOf("Round 1/5"))
    for (const phrase of ["Lock the phone", "direct message", "mentions it", "push notification", "issue tracker"]) {
      expect(text).toContain(phrase)
    }
    expect(text).toContain("the phone's OS, the Discord app version")
  })

  test("takes the number of sessions and the interval, and marks partial", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const fake = fixture(() => ({ ...READY, partial: true }))
    const result = await run(["--account", "work", "--state-dir", dir, "--times", "2", "--interval=10"], fake.deps)
    expect(result.code).toBe(EXIT_OK)
    expect(fake.calls).toHaveLength(2)
    expect(fake.sleeps).toEqual([10_000])
    expect(result.stdout).toContain("2 sessions, 10 s apart")
    expect(result.stdout).toContain("partial: yes")
  })

  test("a single session does not wait", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const fake = fixture()
    await run(["--state-dir", dir, "--times", "1"], fake.deps)
    expect(fake.calls).toHaveLength(1)
    expect(fake.sleeps).toEqual([])
  })

  test("prints neither the token nor anything but counts", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const result = await run(["--state-dir", dir, "--times", "1"], fixture().deps, { env: { DEMO_TOKEN_WORK: TOKEN } })
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
    expect(result.stdout).not.toContain("lastRead")
    expect(result.stdout).not.toContain(READY.userId)
  })
})

describe("gateway-check failures", () => {
  test("a failing round ends the check, with the error masked and no summary", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const fake = fixture((round) => {
      if (round === 2) throw new ToolError("unauthenticated", `Discord rejected the token ${TOKEN}; give it a new one.`)
      return READY
    })
    const result = await run(["--state-dir", dir], fake.deps)
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Discord rejected the token")
    expect(result.stderr).not.toContain(TOKEN)
    expect(fake.calls).toHaveLength(2)
    expect(result.stdout).toContain("Round 1/5")
    expect(result.stdout).not.toContain("Round 2/5")
    expect(result.stdout).not.toContain("Done")
  })

  test("an unexpected error is said generically", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const result = await run(["--state-dir", dir], fixture(() => Promise.reject(new Error(`secret ${TOKEN}`))).deps)
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Unexpected error")
    expect(result.stderr).not.toContain(TOKEN)
  })

  test("a cancellation while waiting is said as one", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const fake = fixture()
    const controller = new AbortController()
    fake.deps.sleep = async () => {
      controller.abort()
      throw abortError(controller.signal)
    }
    const result = await run(["--state-dir", dir], fake.deps, { signal: controller.signal })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("cancelled")
    expect(fake.calls).toHaveLength(1)
  })

  test("an unknown label is refused before a client is made or state created", async () => {
    const dir = await tempStateDir()
    const fake = fixture()
    const result = await run(["--account", "work", "--state-dir", dir], fake.deps)
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain('account "work" was not found')
    expect(result.stdout).toBe("")
    expect(fake.options).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("several accounts need one named", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "first")
    await signedInAccount(dir, "second")
    const fake = fixture()
    const result = await run(["--state-dir", dir], fake.deps)
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain("first, second")
    expect(fake.options).toEqual([])
  })

  test("is reachable through the command line and refuses without an account", async () => {
    const dir = await tempStateDir()
    const result = await cli(["gateway-check", "--state-dir", dir])
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("No Discord account is signed in yet")
  })

  test.each(
    [
      ["--times", "0"],
      ["--times", "21"],
      ["--times", "abc"],
      ["--times", "1.5"],
      ["--times", "-1"],
      ["--times"],
      ["--times="],
      ["--interval", "9"],
      ["--interval", "601"],
      ["--interval", "x"],
      ["--interval"],
      ["--account"],
      ["--account", "Bad"],
      ["--state-dir", "relative"],
      ["--bogus"],
      ["unexpected"],
    ].map((args): [string[]] => [args]),
  )("%j is rejected before anything runs", async (args) => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const fake = fixture()
    const result = await run(args[0] === "--state-dir" ? args : [...args, "--state-dir", dir], fake.deps)
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stdout).toBe("")
    expect(fake.options).toEqual([])
  })

  test.each([
    ["--times", "1"],
    ["--times", "20"],
    ["--interval", "10"],
    ["--interval", "600"],
  ])("%s %s is within the limits", async (flag, value) => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const result = await run(["--state-dir", dir, flag, value], fixture().deps)
    expect(result.code).toBe(EXIT_OK)
  })
})
