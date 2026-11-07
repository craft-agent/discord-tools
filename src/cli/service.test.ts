import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { fakeHost, refusingHost, runCommand, signedInAccount, tempStateDir } from "./commands.testing"
import { SERVICE_ID, runServiceCommand } from "./service"

const run = runCommand.bind(null, runServiceCommand)

describe("service status", () => {
  test("says a waiting timer is scheduled but not running", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir, {
      run: async (argv) => ({
        code: 0,
        stdout: argv.includes("list") || argv.includes("print") ? "state = waiting\n" : "",
        stderr: "",
      }),
    })
    const result = await run(["status", "--account", "work", "--state-dir", dir], { serviceHost: host })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain('Sync service for "work":')
    expect(result.stdout).toContain("Installed: no")
    expect(result.stdout).toContain("Scheduled: yes")
    expect(result.stdout).toContain("Running: no")
    expect(result.stdout).toContain("File:")
  })

  test("picks the only account when --account is absent", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const result = await run(["status", "--state-dir", dir], { serviceHost: fakeHost(dir) })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain('Sync service for "work":')
  })

  test("takes a named account whose state is gone", async () => {
    const dir = await tempStateDir()
    const result = await run(["status", "--account", "gone", "--state-dir", dir], { serviceHost: fakeHost(dir) })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain('Sync service for "gone":')
  })

  test("reports an orphan systemd run and both unit paths without local account files", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir, {
      platform: "linux",
      run: async (argv) => ({
        code: 0,
        stderr: "",
        stdout: argv[3]?.endsWith(".timer")
          ? "LoadState=loaded\nActiveState=active\n"
          : "LoadState=loaded\nActiveState=activating\nMainPID=23\n",
      }),
    })
    const result = await run(["status", "--account=gone", `--state-dir=${dir}`], { serviceHost: host })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stdout).toContain("Installed: no")
    expect(result.stdout).toContain("Scheduled: yes")
    expect(result.stdout).toContain("Running: yes")
    expect(result.stdout).toContain("PID: 23")
    expect(result.stdout).toContain("Timer:")
    expect(result.stdout).toContain("Log: journalctl")
    expect(host.calls).toHaveLength(2)
    expect(await readdir(dir)).toEqual([])
  })

  test("names the accounts when several exist and none is given", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "first")
    await signedInAccount(dir, "second")
    const result = await run(["status", "--state-dir", dir], { serviceHost: fakeHost(dir) })
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain("--account: first, second.")
    expect(result.stdout).toBe("")
  })

  test("fails as usual when there is no account and none is named", async () => {
    const dir = await tempStateDir()
    const result = await run(["status", "--state-dir", dir], { serviceHost: fakeHost(dir) })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toStartWith(`${PROJECT.cli}: `)
  })
})

describe("service uninstall", () => {
  test("takes the named account's registration out, even after its state is gone", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run(["uninstall", "--account", "gone", "--state-dir", dir], { serviceHost: host })
    expect(result).toEqual({ code: EXIT_OK, stdout: 'Uninstalled sync service for "gone".\n', stderr: "" })
    expect(host.calls.length).toBeGreaterThan(0)
    expect(host.calls.flat().some((part) => part.includes(SERVICE_ID))).toBe(true)
  })

  test("fails when the manager refuses", async () => {
    const dir = await tempStateDir()
    const result = await run(["uninstall", "--account", "work", "--state-dir", dir], {
      serviceHost: refusingHost(dir, "Operation not permitted"),
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Operation not permitted")
  })

  test("cleans up absent systemd units using the CLI's service id", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir, {
      platform: "linux",
      run: async (argv) =>
        argv[2] === "daemon-reload"
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: `Unit ${argv.at(-1)} not loaded.` },
    })
    const result = await run(["uninstall", "--account=gone", "--state-dir", dir], { serviceHost: host })
    expect(result.code).toBe(EXIT_OK)
    const base = `${SERVICE_ID.replaceAll(".", "-")}-gone`
    expect(host.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", `${base}.timer`],
      ["systemctl", "--user", "stop", `${base}.service`],
      ["systemctl", "--user", "daemon-reload"],
    ])
    expect(await readdir(dir)).toEqual([])
  })
})

describe("service install", () => {
  test("is refused before any host call or write, after the arguments are checked", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run(["install", "--account", "work", "--state-dir", join(dir, "state")], {
      serviceHost: host,
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(
      `${PROJECT.cli}: Installing the sync service is not available yet: the sync engine is not implemented.\n`,
    )
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("is refused the same way on an unsupported platform", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir, { platform: "win32" })
    const result = await run(["install", "--state-dir", dir], { serviceHost: host })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("not available yet")
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("needs no local account or label to report unavailable", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run(["install", "--state-dir", join(dir, "absent")], { serviceHost: host })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("not available yet")
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("still rejects a bad command line with usage", async () => {
    const dir = await tempStateDir()
    const result = await run(["install", "--account", "Bad Label", "--state-dir", dir])
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain("Invalid label")
  })
})

describe("service usage", () => {
  test.each([
    [[], "No service command given"],
    [["bogus"], 'Unknown service command "bogus"'],
    [["status", "--account"], "--account"],
    [["status", "--nope"], "--nope"],
    [["status", "--yes"], "--yes"],
    [["status", "--state-dir", "relative"], "--state-dir"],
    [["status", "--account", "Bad"], "Invalid label"],
    [["install", "--state-dir", "--account", "work", "/state"], "--state-dir"],
    [["status", "--state-dir="], "--state-dir"],
  ])("%j is one line on stderr and exit 2", async (argv, message) => {
    const result = await run(argv)
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stdout).toBe("")
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1)
    expect(result.stderr).toContain(message)
  })
})
