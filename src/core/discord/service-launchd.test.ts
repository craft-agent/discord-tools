import { describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  buildLaunchdPlist,
  installLaunchdService as installService,
  launchdServiceStatus as serviceStatus,
  uninstallLaunchdService as uninstallService,
  xmlEscape,
} from "./service-launchd"
import { failed, fakeHost, ok, SPEC, withHome } from "./service.testing"

const TARGET = "gui/501/io.example.tools.default"
const NOT_FOUND = failed(113, "Could not find service")

describe("launchd service", () => {
  test("xmlEscape escapes the special characters", () => {
    expect(xmlEscape(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;")
  })

  test("the plist runs at load and every 300 seconds, never kept alive, with escaped strings", () => {
    const xml = buildLaunchdPlist({ ...SPEC, args: ["a <b>", "/state & dir"] }, "/logs/x.log")
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

  test("install writes the plist 0644 in a 0700 log directory, then bootstraps", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("darwin", home, (argv) => (argv[1] === "bootout" ? NOT_FOUND : undefined))
      const result = await installService(SPEC, host)

      const plist = join(home, "Library/LaunchAgents/io.example.tools.default.plist")
      expect(result).toEqual({ file: plist, log: join(home, "Library/Logs/io.example.tools/default.log") })
      expect((await stat(plist)).mode & 0o777).toBe(0o644)
      expect((await stat(join(home, "Library/Logs/io.example.tools"))).mode & 0o777).toBe(0o700)
      expect(await readFile(plist, "utf8")).toContain("<integer>300</integer>")
      expect(calls).toEqual([
        ["launchctl", "bootout", TARGET],
        ["launchctl", "bootstrap", "gui/501", plist],
      ])
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
      await uninstallService(SPEC.id, SPEC.label, host)
      expect(calls).toEqual([["launchctl", "bootout", TARGET]])

      const live = fakeHost("darwin", home)
      const { file } = await installService(SPEC, live.host)
      await uninstallService(SPEC.id, SPEC.label, live.host)
      expect(await stat(file).catch(() => undefined)).toBeUndefined()
    })
  })

  test("uninstall keeps the plist when bootout fails for a real reason", async () => {
    await withHome(async (home) => {
      const { file } = await installService(SPEC, fakeHost("darwin", home).host)
      const { host } = fakeHost("darwin", home, () => failed(5, "Input/output error"))
      await expect(uninstallService(SPEC.id, SPEC.label, host)).rejects.toThrow("Input/output error")
      expect((await stat(file)).isFile()).toBe(true)
      const timedOut = fakeHost("darwin", home, () => ({ code: -1, stdout: "", stderr: "", timedOut: true as const }))
      await expect(uninstallService(SPEC.id, SPEC.label, timedOut.host)).rejects.toThrow("timed out")
      expect((await stat(file)).isFile()).toBe(true)
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
