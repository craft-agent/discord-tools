import { describe, expect, test } from "bun:test"
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  buildLaunchdPlist,
  installLaunchdService as installService,
  LAUNCHER_SCRIPT,
  launchdServiceStatus as serviceStatus,
  uninstallLaunchdService as uninstallService,
  xmlEscape,
} from "./service-launchd"
import { failed, fakeHost, ok, SPEC, withHome } from "./service.testing"

const TARGET = "gui/501/io.example.tools.default"
const NOT_FOUND = failed(113, "Could not find service")

/** The launcher directory and the launcher of the default label, under a made-up home. */
function launcherLocation(home: string, label = SPEC.label) {
  const dir = join(home, "Library/Application Support", SPEC.id)
  return { dir, path: join(dir, `${SPEC.launcher}-${label}`) }
}

describe("launchd service", () => {
  test("xmlEscape escapes the special characters", () => {
    expect(xmlEscape(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;")
  })

  test("the plist runs at load and every 300 seconds, never kept alive, with escaped strings", () => {
    const xml = buildLaunchdPlist({ ...SPEC, args: ["a <b>", "/state & dir"] }, "/logs/x.log", "/support/launcher")
    expect(xml).toContain("<key>Label</key>\n\t<string>io.example.tools.default</string>")
    expect(xml).toContain("<string>a &lt;b&gt;</string>")
    expect(xml).toContain("<string>/state &amp; dir</string>")
    expect(xml).toContain("<key>PATH</key>\n\t\t<string>/usr/bin:/bin</string>")
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>")
    expect(xml).toContain("<key>StartInterval</key>\n\t<integer>300</integer>")
    expect(xml).toContain("<key>ProcessType</key>\n\t<string>Background</string>")
    expect(xml).toContain("<key>StandardOutPath</key>\n\t<string>/logs/x.log</string>")
    expect(xml).not.toContain("KeepAlive")
    expect(xml).not.toContain("ThrottleInterval")
  })

  test("the plist starts the launcher first, then the program and its arguments", () => {
    const xml = buildLaunchdPlist(SPEC, "/logs/x.log", "/support/launcher")
    expect(xml).toContain(
      [
        "<key>ProgramArguments</key>",
        "\t<array>",
        "\t\t<string>/support/launcher</string>",
        "\t\t<string>/usr/bin/node</string>",
        "\t\t<string>/opt/tools/cli.js</string>",
        "\t\t<string>sync</string>",
        "\t</array>",
      ].join("\n"),
    )
  })

  test("install writes the plist 0644 in a 0700 log directory, then bootstraps", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("darwin", home, (argv) => (argv[1] === "bootout" ? NOT_FOUND : undefined))
      const result = await installService(SPEC, host)

      const plist = join(home, "Library/LaunchAgents/io.example.tools.default.plist")
      expect(result).toEqual({ file: plist, log: join(home, "Library/Logs/io.example.tools/default.log") })
      expect((await stat(plist)).mode & 0o777).toBe(0o644)
      expect((await stat(join(home, "Library/Logs/io.example.tools"))).mode & 0o777).toBe(0o700)
      const plistText = await readFile(plist, "utf8")
      expect(plistText).toContain("<integer>300</integer>")
      expect(plistText).toContain(`<string>${launcherLocation(home).path}</string>\n\t\t<string>/usr/bin/node</string>`)
      expect(calls).toEqual([
        ["launchctl", "bootout", TARGET],
        ["launchctl", "enable", TARGET],
        ["launchctl", "bootstrap", "gui/501", plist],
      ])
    })
  })

  test("install writes the launcher script 0755 in a 0700 directory, and a reinstall replaces it without leftovers", async () => {
    await withHome(async (home) => {
      const { dir, path } = launcherLocation(home)
      await installService(SPEC, fakeHost("darwin", home).host)

      expect(await readFile(path, "utf8")).toBe(LAUNCHER_SCRIPT)
      expect(LAUNCHER_SCRIPT).toBe('#!/bin/sh\nexec "$@"\n')
      expect((await stat(path)).mode & 0o777).toBe(0o755)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)

      await writeFile(path, "changed\n")
      await writeFile(join(dir, `.${SPEC.launcher}-${SPEC.label}.tmp`), "stale")
      await installService(SPEC, fakeHost("darwin", home).host)
      expect(await readFile(path, "utf8")).toBe(LAUNCHER_SCRIPT)
      expect(await readdir(dir)).toEqual([`${SPEC.launcher}-${SPEC.label}`])
    })
  })

  test("install replaces a link at the launcher path instead of following it", async () => {
    await withHome(async (home) => {
      const { dir, path } = launcherLocation(home)
      const target = join(home, "elsewhere")
      await writeFile(target, "untouched")
      await mkdir(dir, { recursive: true })
      await symlink(target, path)

      await installService(SPEC, fakeHost("darwin", home).host)

      expect((await lstat(path)).isFile()).toBe(true)
      expect(await readFile(path, "utf8")).toBe(LAUNCHER_SCRIPT)
      expect(await readFile(target, "utf8")).toBe("untouched")
    })
  })

  test("install refuses a bad launcher name before running or writing anything", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("darwin", home)
      for (const launcher of ["", "../evil", "a/b", ".hidden", "a b", "a\nb"]) {
        await expect(installService({ ...SPEC, launcher }, host)).rejects.toThrow("Invalid launcher name")
      }
      expect(calls).toEqual([])
      expect(await stat(join(home, "Library")).catch(() => undefined)).toBeUndefined()
    })
  })

  test("install refuses a bad spec before writing or running anything", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("darwin", home)
      await expect(installService({ ...SPEC, description: "a\nb" }, host)).rejects.toThrow("Control characters")
      await expect(installService({ ...SPEC, program: "node" }, host)).rejects.toThrow("absolute")
      expect(calls).toEqual([])
      expect(await stat(join(home, "Library")).catch(() => undefined)).toBeUndefined()
    })
  })

  test("install does not swallow an unexplained bootout failure, and maps a bootstrap failure", async () => {
    await withHome(async (home) => {
      const io = fakeHost("darwin", home, (argv) =>
        argv[1] === "bootout" ? failed(5, "Input/output error") : undefined,
      )
      await expect(installService(SPEC, io.host)).rejects.toThrow("launchctl failed: Input/output error")
      expect(io.calls).toEqual([["launchctl", "bootout", TARGET]])

      const denied = fakeHost("darwin", home, (argv) =>
        argv[1] === "bootout" ? NOT_FOUND : argv[1] === "bootstrap" ? failed(1, "permission denied") : undefined,
      )
      await expect(installService(SPEC, denied.host)).rejects.toThrow("launchctl failed: permission denied")
    })
  })

  test("uninstall boots out then deletes the plist, and is idempotent when nothing is there", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("darwin", home, (argv) => (argv[1] === "bootout" ? NOT_FOUND : undefined))
      await uninstallService(SPEC, SPEC.label, host)
      expect(calls).toEqual([["launchctl", "bootout", TARGET]])

      const live = fakeHost("darwin", home)
      const { file } = await installService(SPEC, live.host)
      await uninstallService(SPEC, SPEC.label, live.host)
      expect(await stat(file).catch(() => undefined)).toBeUndefined()
    })
  })

  test("uninstall deletes the launcher and its directory once empty, but not another label's launcher", async () => {
    await withHome(async (home) => {
      const { host } = fakeHost("darwin", home)
      await installService(SPEC, host)
      await installService({ ...SPEC, label: "work" }, host)
      const { dir, path } = launcherLocation(home)

      await uninstallService(SPEC, SPEC.label, host)
      expect(await stat(path).catch(() => undefined)).toBeUndefined()
      expect(await readdir(dir)).toEqual([`${SPEC.launcher}-work`])

      await uninstallService(SPEC, "work", host)
      expect(await stat(dir).catch(() => undefined)).toBeUndefined()
    })
  })

  test("uninstall leaves a link at the launcher path and its target alone", async () => {
    await withHome(async (home) => {
      const { dir, path } = launcherLocation(home)
      const target = join(home, "elsewhere")
      await writeFile(target, "untouched")
      await mkdir(dir, { recursive: true })
      await symlink(target, path)

      await uninstallService(SPEC, SPEC.label, fakeHost("darwin", home).host)

      expect(await readlink(path)).toBe(target)
      expect(await readFile(target, "utf8")).toBe("untouched")
    })
  })

  test("uninstall checks the launcher name only after unloading the agent and deleting its plist", async () => {
    await withHome(async (home) => {
      const { file } = await installService(SPEC, fakeHost("darwin", home).host)
      const { host, calls } = fakeHost("darwin", home)

      await expect(uninstallService({ ...SPEC, launcher: "../evil" }, SPEC.label, host)).rejects.toThrow(
        "Invalid launcher name",
      )
      expect(calls).toEqual([["launchctl", "bootout", TARGET]])
      expect(await stat(file).catch(() => undefined)).toBeUndefined()
      expect((await stat(launcherLocation(home).path)).isFile()).toBe(true)
    })
  })

  test("uninstall keeps the plist when bootout fails for a real reason", async () => {
    await withHome(async (home) => {
      const { file } = await installService(SPEC, fakeHost("darwin", home).host)
      const { host } = fakeHost("darwin", home, () => failed(5, "Input/output error"))
      await expect(uninstallService(SPEC, SPEC.label, host)).rejects.toThrow("Input/output error")
      expect((await stat(file)).isFile()).toBe(true)
      const timedOut = fakeHost("darwin", home, () => ({ code: -1, stdout: "", stderr: "", timedOut: true as const }))
      await expect(uninstallService(SPEC, SPEC.label, timedOut.host)).rejects.toThrow("timed out")
      expect((await stat(file)).isFile()).toBe(true)
      expect((await stat(launcherLocation(home).path)).isFile()).toBe(true)
    })
  })

  test("status reports installed, scheduled and running separately", async () => {
    await withHome(async (home) => {
      const missing = fakeHost("darwin", home, () => NOT_FOUND)
      expect(await serviceStatus(SPEC.id, SPEC.label, missing.host)).toMatchObject({
        installed: false,
        scheduled: false,
        running: false,
      })

      await installService(SPEC, fakeHost("darwin", home).host)

      const waiting = fakeHost("darwin", home, () => ok("state = waiting\nlast exit code = 1\n"))
      const idle = await serviceStatus(SPEC.id, SPEC.label, waiting.host)
      expect(idle).toMatchObject({ installed: true, scheduled: true, running: false, lastExit: 1 })
      expect(idle.pid).toBeUndefined()

      const running = fakeHost("darwin", home, () => ok("state = running\npid = 4321\nlast exit code = 0\n"))
      expect(await serviceStatus(SPEC.id, SPEC.label, running.host)).toMatchObject({
        installed: true,
        scheduled: true,
        running: true,
        pid: 4321,
        lastExit: 0,
      })

      const unloaded = fakeHost("darwin", home, () => NOT_FOUND)
      expect(await serviceStatus(SPEC.id, SPEC.label, unloaded.host)).toMatchObject({
        installed: true,
        scheduled: false,
      })

      const broken = fakeHost("darwin", home, () => failed(1, "boom"))
      await expect(serviceStatus(SPEC.id, SPEC.label, broken.host)).rejects.toThrow("launchctl failed: boom")
    })
  })
})
