import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../core"
import { labelPaths } from "../core/discord/labels"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { fakeHost, runCommand, signedInAccount, tempStateDir } from "./commands.testing"
import { runSyncCommand } from "./sync"
import { PROFILE } from "./testing"

const run = runCommand.bind(null, runSyncCommand)
const counts = { requests: 3, channels: 2, stored: 7, deleted: 1, skipped: 0 }

describe("sync command", () => {
  test.each(["complete", "partial", "busy"] as const)("reports %s with its exit code", async (status) => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir)
    const signal = new AbortController().signal
    const env = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (String(key).includes("TOKEN")) throw new Error("entry must not read tokens")
          return undefined
        },
      },
    )
    const result = await run(["--state-dir", dir], {
      env,
      signal,
      serviceHost: host,
      profile: PROFILE,
      syncRun: async (options) => {
        const { env: suppliedEnv, ...rest } = options
        expect(suppliedEnv).toBe(env)
        expect(rest).toEqual({
          stateDir: dir,
          paths: labelPaths(dir, "work"),
          tokenVariable: "DEMO_TOKEN_WORK",
          signal,
        })
        return { status, ...counts }
      },
    })
    expect(result.code).toBe(status === "partial" ? EXIT_FAILED : EXIT_OK)
    expect(result.stdout).toContain(`Sync ${status}: requests=3, channels=2, stored=7, deleted=1, skipped=0.`)
    expect(result.stderr).toBe("")
    expect(host.calls).toEqual([])
  })

  test("unknown labels fail before sync, state creation or service management", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run(["--account=work", `--state-dir=${join(dir, "absent")}`], {
      serviceHost: host,
      syncRun: async () => {
        throw new Error("must not run")
      },
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain('account "work" was not found')
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test.each([false, true])(
    "authentication rejection is printed before suspending; suspension failure=%s",
    async (fails) => {
      const dir = await tempStateDir()
      await signedInAccount(dir, "work")
      const events: string[] = []
      let stderr = ""
      const host = fakeHost(dir, {
        run: async (argv) => {
          events.push(argv[1]!)
          return { code: fails ? 1 : 0, stdout: "", stderr: fails ? "private-manager-detail" : "" }
        },
      })
      const result = await run(["--account", "work", "--state-dir", dir], {
        serviceHost: host,
        stderr: (text) => {
          stderr += text
          events.push("stderr")
        },
        syncRun: async () => {
          throw new ToolError("unauthenticated", "The token was rejected; sign in again.")
        },
      })
      expect(result.code).toBe(EXIT_FAILED)
      expect(stderr).toContain("The token was rejected; sign in again.")
      expect(stderr.match(/The token was rejected/g)).toHaveLength(1)
      expect(stderr).not.toContain("private-manager-detail")
      expect(events).toEqual(fails ? ["stderr", "disable", "stderr"] : ["stderr", "disable", "bootout"])
      expect(result.stdout).toBe("")
      if (fails) expect(stderr).toContain("schedule could not be paused")
    },
  )

  test("a forbidden challenge does not suspend the schedule", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir)
    const result = await run(["--state-dir", dir], {
      serviceHost: host,
      syncRun: async () => {
        throw new ToolError("forbidden", "Complete the account challenge.")
      },
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Complete the account challenge.")
    expect(host.calls).toEqual([])
  })

  test("other failures do not stop the schedule or reveal unexpected error details", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir)
    const result = await run(["--state-dir", dir], {
      serviceHost: host,
      syncRun: async () => {
        throw new Error("private-token-or-message")
      },
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Unexpected error")
    expect(result.stderr).not.toContain("private-token-or-message")
    expect(host.calls).toEqual([])
  })

  test("ambiguous labels produce usage without running", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "first")
    await signedInAccount(dir, "second")
    const result = await run(["--state-dir", dir])
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain("first, second")
  })

  test.each(
    [
      ["--account"],
      ["--account="],
      ["--account", "Bad"],
      ["--yes"],
      ["--bogus"],
      ["--state-dir"],
      ["--state-dir="],
      ["--state-dir", "relative"],
      ["--state-dir", "--account", "work", "/state"],
      ["unexpected"],
    ].map((args): [string[]] => [args]),
  )("%j is rejected before running", async (args) => {
    const result = await run(args)
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stdout).toBe("")
  })
})
