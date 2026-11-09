import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { exec, type ExecResult } from "../exec"
import { Scratch } from "./archive.testing"
import { quarantine, type QuarantineOptions } from "./quarantine"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const VALUE = /^0081;[0-9a-f]+;agent;[0-9A-F-]{36}$/
const OK: ExecResult = { code: 0, stdout: "", stderr: "" }

type Call = { argv: string[]; env: Record<string, string>; timeoutMs?: number }

/** A fake `exec` that records its calls and answers with `reply`. */
function recorder(reply: () => Promise<ExecResult> = async () => OK) {
  const calls: Call[] = []
  const run: typeof exec = async (argv, options) => {
    calls.push({ argv, env: options.env, timeoutMs: options.timeoutMs })
    return reply()
  }
  return { calls, run }
}

const optionsOf = (run: typeof exec, extra: Partial<QuarantineOptions> = {}): QuarantineOptions => ({
  agent: "agent",
  env: { PATH: "/usr/bin" },
  now: () => 1_700_000_000_000,
  platform: "darwin",
  run,
  ...extra,
})

async function files(count: number): Promise<string[]> {
  const paths: string[] = []
  for (let i = 0; i < count; i++) paths.push(await scratch.write(`f${i}.txt`, "x"))
  return paths
}

describe("quarantine", () => {
  test("runs xattr once with the value, the paths and the environment given", async () => {
    const { calls, run } = recorder()
    const paths = await files(2)
    await quarantine(paths, optionsOf(run))
    expect(calls).toHaveLength(1)
    const [program, link, write, attribute, value, separator, ...rest] = calls[0].argv
    expect([program, link, write, attribute, separator]).toEqual([
      "/usr/bin/xattr",
      "-s",
      "-w",
      "com.apple.quarantine",
      "--",
    ])
    expect(value).toMatch(VALUE)
    expect(value.split(";")[1]).toBe((1_700_000_000).toString(16))
    expect(rest).toEqual(paths)
    expect(calls[0].env).toEqual({ PATH: "/usr/bin" })
    expect(calls[0].timeoutMs).toBe(60_000)
  })

  test("removes the characters that would break the value out of the agent name", async () => {
    const { calls, run } = recorder()
    await quarantine(await files(1), optionsOf(run, { agent: "a;b\nc\u007fd" }))
    expect(calls[0].argv[4]).toMatch(/^0081;[0-9a-f]+;abcd;[0-9A-F-]{36}$/)
  })

  test("marks a hundred paths to a call", async () => {
    const { calls, run } = recorder()
    await quarantine(await files(250), optionsOf(run))
    expect(calls.map((call) => call.argv.length - 6)).toEqual([100, 100, 50])
  })

  test("skips links and folders", async () => {
    const { calls, run } = recorder()
    const [file] = await files(1)
    const link = await scratch.path("link.txt")
    await symlink(file, link)
    const folder = await scratch.path("folder")
    await mkdir(folder)
    await quarantine([link, folder, await scratch.path("missing.txt"), file], optionsOf(run))
    expect(calls[0].argv.slice(6)).toEqual([file])
  })

  test("runs nothing when no path is left", async () => {
    const { calls, run } = recorder()
    await quarantine([], optionsOf(run))
    await quarantine([await scratch.path("missing.txt")], optionsOf(run))
    expect(calls).toHaveLength(0)
  })

  test("runs nothing outside macOS", async () => {
    const { calls, run } = recorder()
    await quarantine(await files(1), optionsOf(run, { platform: "linux" }))
    expect(calls).toHaveLength(0)
  })

  test("swallows a failed run, a refused one and a missing program, and goes on with the next group", async () => {
    const replies = [
      async () => ({ ...OK, code: 1, stderr: "denied" }),
      async () => ({ ...OK, code: -1, timedOut: true as const }),
      async () => {
        throw Object.assign(new Error("spawn"), { code: "ENOENT" })
      },
    ]
    let call = 0
    const { calls, run } = recorder(() => replies[call++]())
    await quarantine(await files(250), optionsOf(run))
    expect(calls).toHaveLength(3)
  })

  test("stops quietly when aborted", async () => {
    const { calls, run } = recorder()
    const controller = new AbortController()
    controller.abort()
    await quarantine(await files(1), optionsOf(run, { signal: controller.signal }))
    expect(calls).toHaveLength(0)
  })

  test.skipIf(process.platform !== "darwin")("marks a real file the system reads back", async () => {
    const [file] = await files(1)
    await quarantine([file], { agent: "agent", env: { PATH: "/usr/bin" }, now: Date.now })
    const read = await exec(["/usr/bin/xattr", "-p", "com.apple.quarantine", file], { env: { PATH: "/usr/bin" } })
    expect(read.stdout.trim()).toMatch(VALUE)
  })
})
