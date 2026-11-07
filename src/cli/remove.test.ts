import { describe, expect, test } from "bun:test"
import { readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../core"
import { acquireSyncLock } from "../core/discord/sync-lock"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { fakeHost, refusingHost, runCommand, signedInAccount, tempStateDir } from "./commands.testing"
import { runRemoveCommand } from "./remove"
import { PROFILE } from "./testing"

const run = runCommand.bind(null, runRemoveCommand)

describe("remove confirmation", () => {
  test("--yes removes only the selected label after uninstalling", async () => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    await signedInAccount(dir, "other")
    let existedAtUninstall = false
    const host = fakeHost(dir, {
      run: async () => {
        existedAtUninstall = (await stat(account)).isDirectory()
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    const result = await run(["--account=work", "--yes", `--state-dir=${dir}`], {
      profile: PROFILE,
      serviceHost: host,
      isTTY: false,
      readLine: async () => {
        throw new Error("must not prompt")
      },
    })
    expect(result.code).toBe(EXIT_OK)
    expect(existedAtUninstall).toBe(true)
    expect(host.calls).toHaveLength(1)
    expect(host.calls[0]!.at(-1)).toContain(PROFILE.serviceId)
    expect(await readdir(dir)).toEqual(["other"])
    expect(result.stdout).toContain("local state is deleted")
    expect(result.stdout).toContain("environment are not removed")
  })

  test("a terminal can confirm by typing the exact label", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const result = await run(["--account", "work", "--state-dir", dir], {
      serviceHost: fakeHost(dir),
      isTTY: true,
      readLine: async (prompt) => {
        expect(prompt).toContain('type the label "work"')
        return "work"
      },
    })
    expect(result.code).toBe(EXIT_OK)
    expect(result.stderr).toContain("permanently delete")
    expect(await readdir(dir)).toEqual([])
  })

  test.each(["other", " work ", "", undefined])("refuses mismatch or EOF %j without changing state", async (answer) => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    const host = fakeHost(dir)
    const result = await run(["--account", "work", "--state-dir", dir], {
      serviceHost: host,
      isTTY: true,
      readLine: async () => answer,
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("cancelled")
    expect(host.calls).toEqual([])
    expect(await readdir(account)).toEqual(["token"])
  })

  test("non-terminal input requires --yes", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir)
    const result = await run(["--account", "work", "--state-dir", dir], {
      serviceHost: host,
      isTTY: false,
      readLine: async () => {
        throw new Error("must not prompt")
      },
    })
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stderr).toContain("--yes")
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual(["work"])
  })

  test("checks existence before prompting", async () => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    let prompted = false
    const result = await run(["--account", "gone", "--state-dir", dir], {
      serviceHost: host,
      isTTY: true,
      readLine: async () => {
        prompted = true
        return "gone"
      },
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("was not found")
    expect(prompted).toBe(false)
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test.each(["before", "during"])("aborting %s confirmation preserves state", async (when) => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    const controller = new AbortController()
    const host = fakeHost(dir)
    if (when === "before") controller.abort()
    const result = await run(["--account", "work", "--state-dir", dir], {
      serviceHost: host,
      isTTY: true,
      signal: controller.signal,
      readLine: async () => {
        controller.abort()
        return "work"
      },
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("cancelled")
    expect(host.calls).toEqual([])
    expect(await readdir(account)).toEqual(["token"])
  })
})

describe("remove failures", () => {
  test("cancellation while stopping the service preserves state", async () => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    const controller = new AbortController()
    const host = fakeHost(dir, {
      run: async () => {
        controller.abort()
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    const result = await run(["--account", "work", "--yes", "--state-dir", dir], {
      serviceHost: host,
      signal: controller.signal,
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("cancelled")
    expect(host.calls).toHaveLength(1)
    expect(await readdir(account)).toEqual(["token"])
  })

  test("manager failures preserve local state", async () => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    const result = await run(["--account", "work", "--yes", "--state-dir", dir], {
      serviceHost: refusingHost(dir, "Operation not permitted"),
    })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Operation not permitted")
    expect(result.stdout).toBe("")
    expect(await readdir(account)).toEqual(["token"])
  })

  test("invalid_argument from a supported manager is not mistaken for an unsupported platform", async () => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    const host = fakeHost(dir, {
      run: async () => {
        throw new ToolError("invalid_argument", "Manager refused")
      },
    })
    const result = await run(["--account", "work", "--yes", "--state-dir", dir], { serviceHost: host })
    expect(result.code).toBe(EXIT_FAILED)
    expect(result.stderr).toContain("Manager refused")
    expect(await readdir(account)).toEqual(["token"])
  })

  test("skips the service manager only on an unsupported host platform", async () => {
    const dir = await tempStateDir()
    await signedInAccount(dir, "work")
    const host = fakeHost(dir, {
      platform: "win32",
      run: async () => {
        throw new Error("must not run")
      },
    })
    const result = await run(["--account", "work", "--yes", "--state-dir", dir], { serviceHost: host })
    expect(result.code).toBe(EXIT_OK)
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  test("a busy sync lock fails after uninstall and preserves state", async () => {
    const dir = await tempStateDir()
    const account = await signedInAccount(dir, "work")
    await writeFile(join(account, "mirror-marker"), "preserve")
    const release = acquireSyncLock(join(account, "sync.lock"))!
    try {
      const host = fakeHost(dir)
      const result = await run(["--account", "work", "--yes", "--state-dir", dir], { serviceHost: host })
      expect(result.code).toBe(EXIT_FAILED)
      expect(result.stderr).toContain("sync lock")
      expect(host.calls).toHaveLength(1)
      expect(await readdir(account)).toContain("mirror-marker")
      expect(await readdir(account)).toContain("token")
    } finally {
      release()
    }
  })

  test.each(
    [
      [],
      ["--yes"],
      ["--account"],
      ["--account="],
      ["--account", "Bad"],
      ["--account", "work", "--yes=true"],
      ["--account", "work", "--nope"],
      ["--state-dir", "--yes", "/state", "--account", "work"],
    ].map((args): [string[]] => [args]),
  )("invalid flags %j have no effects", async (argv) => {
    const dir = await tempStateDir()
    const host = fakeHost(dir)
    const result = await run([...argv, `--state-dir=${dir}`], { serviceHost: host })
    expect(result.code).toBe(EXIT_USAGE)
    expect(result.stdout).toBe("")
    expect(host.calls).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })
})
