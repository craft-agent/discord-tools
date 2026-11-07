import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_USAGE } from "./command-io"
import { fakeHost, runCommand, tempStateDir } from "./commands.testing"
import { runSyncCommand } from "./sync"

const run = runCommand.bind(null, runSyncCommand)

describe("sync unavailable", () => {
  test.each([[], ["--account", "work"], ["--account=work"]].map((args): [string[]] => [args]))(
    "%j reports unavailable without creating any state",
    async (args) => {
      const dir = await tempStateDir()
      const host = fakeHost(dir)
      const result = await run([...args, `--state-dir=${join(dir, "absent")}`], {
        serviceHost: host,
        env: new Proxy(
          {},
          {
            get: (_target, key) => {
              if (String(key).includes("TOKEN")) throw new Error("must not read credentials")
              return undefined
            },
          },
        ),
      })
      expect(result).toEqual({
        code: EXIT_FAILED,
        stdout: "",
        stderr: `${PROJECT.cli}: Sync is not available yet: the sync engine is not implemented.\n`,
      })
      expect(host.calls).toEqual([])
      expect(await readdir(dir)).toEqual([])
    },
  )

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
  )("%j is rejected before unavailable", async (args) => {
    const result = await run(args)
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stdout).toBe("")
    expect(result.stderr).not.toContain("not available yet")
  })
})
