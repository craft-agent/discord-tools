import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { PROJECT } from "../project"
import { writeAccount } from "../core/discord/account-meta"
import { labelPaths } from "../core/discord/labels"
import { PROJECT_PROFILE } from "../entry/profile"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { fakeHost, refusingHost, runCommand, signedInAccount, tempStateDir } from "./commands.testing"
import { runServiceCommand } from "./service"
import { PROFILE } from "./testing"

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
    const result = await run(["status", "--account", "work", "--state-dir", dir], {
      serviceHost: host,
      profile: PROFILE,
    })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain('Sync service for "work":')
    expect(result.stdout).toContain("Installed: no")
    expect(result.stdout).toContain("Scheduled: yes")
    expect(result.stdout).toContain("Running: no")
    expect(result.stdout).toContain("File:")
    expect(result.stdout).toContain(PROFILE.serviceId)
    expect(host.calls.flat().some((part) => part.includes(PROFILE.serviceId))).toBe(true)
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
    const result = await run(["uninstall", "--account", "gone", "--state-dir", dir], {
      serviceHost: host,
      profile: PROFILE,
    })
    expect(result).toEqual({ code: EXIT_OK, stdout: 'Uninstalled sync service for "gone".\n', stderr: "" })
    expect(host.calls.length).toBeGreaterThan(0)
    expect(host.calls.flat().some((part) => part.includes(PROFILE.serviceId))).toBe(true)
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
    const base = `${PROJECT_PROFILE.serviceId.replaceAll(".", "-")}-gone`
    expect(host.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", `${base}.timer`],
      ["systemctl", "--user", "stop", `${base}.service`],
      ["systemctl", "--user", "daemon-reload"],
    ])
    expect(await readdir(dir)).toEqual([])
  })
})

describe("service install", () => {
  test("unknown labels fail before any host call or write", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run(["install", "--account", "work", "--state-dir", join(dir, "state")], {
      serviceHost: host,
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain('account "work" was not found')
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("requires a verified identity, not just a token file", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir)
    const result = await run(["install", "--state-dir", dir], { serviceHost: host })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("run login first")
    expect(host.calls).toEqual([])
  })

  test("requires a local account when no label is supplied", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run(["install", "--state-dir", join(dir, "absent")], { serviceHost: host })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("No Discord account is signed in")
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test.each(["darwin", "linux"] as const)(
    "installs a bounded CLI command on %s without serializing tokens",
    async (platform) => {
      const dir = await tempStateDir()
      await signedInAccount(dir, "work")
      await writeAccount(labelPaths(dir, "work"), { id: "123456789012345678", name: "test", verifiedAt: 1 })
      const host = fakeHost(dir, { platform })
      const result = await run(["install", "--account=work", `--state-dir=${dir}`], {
        profile: PROFILE,
        serviceHost: host,
        program: "/runtime/node",
        entryPath: "/package/dist/cli.js",
        env: { PATH: "/safe/bin", DISCORD_TOOLS_TOKEN_WORK: "made-up-private-token" },
      })
      expect(result.code).toBe(EXIT_OK)
      expect(result.stdout).toContain("supplied independently")
      expect(host.calls.length).toBeGreaterThan(0)
      const file =
        platform === "darwin"
          ? join(dir, "Library", "LaunchAgents", `${PROFILE.serviceId}.work.plist`)
          : join(dir, ".config", "systemd", "user", `${PROFILE.serviceId.replaceAll(".", "-")}-work.service`)
      const definition = await readFile(file, "utf8")
      for (const part of [
        "/runtime/node",
        "/package/dist/cli.js",
        "sync",
        "--account",
        "work",
        "--state-dir",
        dir,
        "/safe/bin",
      ]) {
        expect(definition).toContain(part)
      }
      expect(definition).not.toContain("made-up-private-token")
      expect(definition).not.toContain("TOKEN_WORK")
    },
  )

  test("on macOS the plist starts the launcher named after the package, then the runtime", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    await writeAccount(labelPaths(dir, "work"), { id: "123456789012345678", name: "test", verifiedAt: 1 })
    const result = await run(["install", "--account=work", `--state-dir=${dir}`], {
      profile: PROFILE,
      serviceHost: fakeHost(dir),
      program: "/runtime/node",
      entryPath: "/package/dist/cli.js",
    })
    expect(result.code).toBe(EXIT_OK)
    const launcher = join(dir, "Library", "Application Support", PROFILE.serviceId, `${PROFILE.name}-sync-work`)
    const plist = await readFile(join(dir, "Library", "LaunchAgents", `${PROFILE.serviceId}.work.plist`), "utf8")
    expect(plist).toContain(`<array>\n\t\t<string>${launcher}</string>\n\t\t<string>/runtime/node</string>`)
    expect((await readFile(launcher, "utf8")).startsWith("#!/bin/sh")).toBe(true)
  })

  test.each([undefined, "relative/cli.js"])("refuses unusable entry path %j before installing", async (entryPath) => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    await writeAccount(labelPaths(dir, "work"), { id: "123456789012345678", name: "test", verifiedAt: 1 })
    const host = fakeHost(dir)
    const result = await run(["install", "--state-dir", dir], { serviceHost: host, entryPath })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("absolute built CLI entry path")
    expect(host.calls).toEqual([])
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
