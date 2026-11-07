import { describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  buildSystemdService,
  buildSystemdTimer,
  installSystemdService as installService,
  quoteSystemdArg,
  uninstallSystemdService as uninstallService,
} from "./service-systemd"
import { failed, fakeHost, SPEC, withHome } from "./service.testing"

const SERVICE = "io-example-tools-default.service"
const TIMER = "io-example-tools-default.timer"
const systemctl = (...args: string[]) => ["systemctl", "--user", ...args]

describe("systemd service units", () => {
  test("quoteSystemdArg escapes backslashes, quotes, percent and dollar signs", () => {
    expect(quoteSystemdArg('C:\\P "x" %u $VAR')).toBe('"C:\\\\P \\"x\\" %%u $$VAR"')
  })

  test("the service is a oneshot with a quoted ExecStart and no restart or credentials", () => {
    const unit = buildSystemdService({
      ...SPEC,
      description: "Sync 100% (default)",
      program: "/opt/my tools/node",
      args: ["cli.js", "$100", "%h", 'say "hi"'],
      path: "/usr/bin:/home/%u/bin",
    })
    expect(unit).toContain("Description=Sync 100%% (default)")
    expect(unit).toContain("Type=oneshot")
    expect(unit).toContain('ExecStart="/opt/my tools/node" "cli.js" "$$100" "%%h" "say \\"hi\\""')
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/%%u/bin"')
    expect(unit).not.toMatch(/Restart|WantedBy|TOKEN/i)
  })

  test("the timer starts the service after 1s and every 300s, without a loop", () => {
    const unit = buildSystemdTimer(SPEC, SERVICE)
    expect(unit).toContain("[Timer]\nOnStartupSec=1s\nOnUnitActiveSec=300s\nAccuracySec=1s\n")
    expect(unit).toContain(`Unit=${SERVICE}`)
    expect(unit).toContain("[Install]\nWantedBy=timers.target")
  })

  test("install writes both units 0644, reloads, then enables the timer", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("linux", home)
      host.env.XDG_CONFIG_HOME = join(home, "cfg")
      const result = await installService(SPEC, host)

      const dir = join(home, "cfg/systemd/user")
      expect(result).toEqual({
        file: join(dir, SERVICE),
        timer: join(dir, TIMER),
        log: `journalctl --user -u ${SERVICE}`,
      })
      expect((await stat(join(dir, SERVICE))).mode & 0o777).toBe(0o644)
      expect((await stat(join(dir, TIMER))).mode & 0o777).toBe(0o644)
      expect(await readFile(join(dir, TIMER), "utf8")).toContain("OnUnitActiveSec=300s")
      expect(calls).toEqual([systemctl("daemon-reload"), systemctl("enable", "--now", TIMER)])
    })
  })

  test("install refuses a bad spec without writing or running anything", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("linux", home)
      await expect(installService({ ...SPEC, description: "a\nb" }, host)).rejects.toThrow("the description")
      await expect(installService({ ...SPEC, args: ["x\0"] }, host)).rejects.toThrow("an argument")
      expect(calls).toEqual([])
      expect(await stat(join(home, ".config")).catch(() => undefined)).toBeUndefined()
    })
  })

  test("install propagates a systemctl failure", async () => {
    await withHome(async (home) => {
      const { host } = fakeHost("linux", home, (argv) =>
        argv[2] === "enable" ? failed(1, "Failed to connect to bus") : undefined,
      )
      await expect(installService(SPEC, host)).rejects.toThrow("systemctl failed: Failed to connect to bus")
    })
  })

  test("uninstall disables, stops, deletes both units and reloads; absent units are fine", async () => {
    await withHome(async (home) => {
      const live = fakeHost("linux", home)
      const { file, timer } = await installService(SPEC, live.host)
      const absent = failed(1, "Unit io-example-tools-default.timer not loaded.")
      const { host, calls } = fakeHost("linux", home, (argv) => (argv[2] === "disable" ? absent : undefined))

      await uninstallService(SPEC.id, SPEC.label, host)
      expect(calls).toEqual([
        systemctl("disable", "--now", TIMER),
        systemctl("stop", SERVICE),
        systemctl("daemon-reload"),
      ])
      expect(await stat(file!).catch(() => undefined)).toBeUndefined()
      expect(await stat(timer!).catch(() => undefined)).toBeUndefined()

      await uninstallService(SPEC.id, SPEC.label, host)
    })
  })

  test("uninstall propagates permission and bus failures and keeps the files", async () => {
    await withHome(async (home) => {
      const { file, timer } = await installService(SPEC, fakeHost("linux", home).host)
      for (const stderr of [
        "Access denied",
        "Failed to connect to bus: No medium found",
        "Failed to connect to bus: not found",
        "Unit another.timer not found.",
      ]) {
        const { host } = fakeHost("linux", home, (argv) => (argv[2] === "disable" ? failed(1, stderr) : undefined))
        await expect(uninstallService(SPEC.id, SPEC.label, host)).rejects.toThrow(stderr)
      }
      expect((await stat(file!)).isFile()).toBe(true)
      expect((await stat(timer!)).isFile()).toBe(true)
    })
  })

  test("uninstall keeps files when absence text accompanies an abnormal exit", async () => {
    await withHome(async (home) => {
      const { file, timer } = await installService(SPEC, fakeHost("linux", home).host)
      for (const result of [
        failed(-1, `Unit ${TIMER} not loaded.`),
        { ...failed(1, `Unit ${TIMER} not loaded.`), timedOut: true as const },
        { ...failed(1, `Unit ${TIMER} not loaded.`), signal: "SIGTERM" as const },
      ]) {
        await expect(
          uninstallService(SPEC.id, SPEC.label, fakeHost("linux", home, () => result).host),
        ).rejects.toThrow()
        expect((await stat(file)).isFile()).toBe(true)
        expect((await stat(timer!)).isFile()).toBe(true)
      }
    })
  })
})
