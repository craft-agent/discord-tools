import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./cli"
import { fakeHost, signedInAccount, tempStateDir } from "./commands.testing"
import { cli } from "./testing"

describe("local lifecycle routing", () => {
  test.each(["sync", "service", "remove"])("%s bypasses JSON input and tool settings", async (command) => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    await signedInAccount(dir, "work")
    const args = command === "service" ? ["status"] : command === "remove" ? ["--yes"] : []
    const result = await cli([command, ...args, "--account", "work", "--state-dir", dir], "not JSON", {
      serviceHost: host,
      env: { DEMO_TOOLSETS: "unknown", DEMO_READ_ONLY: "invalid" },
      readStdin: async () => {
        throw new Error("lifecycle commands must not read JSON stdin")
      },
    })
    expect(result.code).toBe(command === "sync" ? EXIT_FAILED : EXIT_OK)
    if (command === "sync") {
      expect(result.stderr).toContain("not available yet")
      expect(host.calls).toEqual([])
    } else if (command === "service") {
      expect(result.stdout).toContain("Installed:")
      expect(host.calls).toHaveLength(1)
    } else {
      expect(result.stdout).toContain("local state is deleted")
      expect(await readdir(dir)).toEqual([])
    }
  })

  test("service install is unavailable through runCli with no local label", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await cli(["service", "install", "--state-dir", dir], "", { serviceHost: host })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Installing the sync service is not available yet")
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test.each(["login", "toString", "constructor", "__proto__"])("%s is not a command", async (command) => {
    const result = await cli([command])
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain(`Unknown command "${command}"`)
    expect(result.stdout).toBe("")
  })

  test("unexpected lifecycle errors reveal no message or stack", async () => {
    const dir = await tempStateDir()
    const result = await cli(["service", "status", "--account", "work", "--state-dir", dir], "", {
      serviceHost: fakeHost(dir, {
        run: async () => {
          throw new Error("private-detail")
        },
      }),
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("Unexpected error; the command failed.")
    expect(result.stderr).not.toContain("private-detail")
    expect(result.stderr).not.toContain("at ")
  })
})
