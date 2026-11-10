import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { installService, suspendService } from "./service"
import { failed, fakeHost, ok, SPEC, withHome } from "./service.testing"

const TARGET = "gui/501/io.example.tools.default"
const TIMER = "io-example-tools-default.timer"

describe("suspend service", () => {
  test.each(["darwin", "linux"] as const)("%s keeps definition bytes and can be reinstalled", async (platform) => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost(platform, home)
      const installed = await installService(SPEC, host)
      const files = [installed.file, ...(installed.timer ? [installed.timer] : [])]
      const before = await Promise.all(files.map((file) => readFile(file, "utf8")))
      calls.length = 0
      await suspendService(SPEC.id, SPEC.label, host)
      expect(calls).toEqual(
        platform === "darwin"
          ? [
              ["launchctl", "disable", TARGET],
              ["launchctl", "bootout", TARGET],
            ]
          : [["systemctl", "--user", "disable", "--now", TIMER]],
      )
      expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(before)
      calls.length = 0
      await installService(SPEC, host)
      expect(calls).toEqual(
        platform === "darwin"
          ? [
              ["launchctl", "bootout", TARGET],
              ["launchctl", "print", TARGET],
              ["launchctl", "enable", TARGET],
              ["launchctl", "bootstrap", "gui/501", installed.file],
            ]
          : [
              ["systemctl", "--user", "daemon-reload"],
              ["systemctl", "--user", "enable", "--now", TIMER],
            ],
      )
    })
  })

  test.each(["rejection", "termination"])("launchd disables before bootout %s and keeps its plist", async (failure) => {
    await withHome(async (home) => {
      const { file } = await installService(SPEC, fakeHost("darwin", home).host)
      const before = await readFile(file, "utf8")
      let disabled = false
      const { host, calls } = fakeHost("darwin", home, (argv) => {
        if (argv[1] === "disable") {
          disabled = true
          return ok()
        }
        expect(disabled).toBe(true)
        if (failure === "termination") throw new Error("simulated termination")
        return failed(5, "Input/output error")
      })
      await expect(suspendService(SPEC.id, SPEC.label, host)).rejects.toThrow()
      expect(calls).toEqual([
        ["launchctl", "disable", TARGET],
        ["launchctl", "bootout", TARGET],
      ])
      expect(await readFile(file, "utf8")).toBe(before)
    })
  })

  test("launchd refuses to boot out when persistent disable fails", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("darwin", home, () => failed(1, "permission denied"))
      await expect(suspendService(SPEC.id, SPEC.label, host)).rejects.toThrow("permission denied")
      expect(calls).toEqual([["launchctl", "disable", TARGET]])
    })
  })

  test("launchd enable failure keeps a valid definition and prevents bootstrap", async () => {
    await withHome(async (home) => {
      const { file } = await installService(SPEC, fakeHost("darwin", home).host)
      const { host, calls } = fakeHost("darwin", home, (argv) =>
        argv[1] === "enable" ? failed(1, "permission denied") : undefined,
      )
      await expect(installService(SPEC, host)).rejects.toThrow("permission denied")
      expect(await readFile(file, "utf8")).toContain("<key>StartInterval</key>")
      expect(calls).toEqual([
        ["launchctl", "bootout", TARGET],
        ["launchctl", "print", TARGET],
        ["launchctl", "enable", TARGET],
      ])
    })
  })

  test("launchd suspend returns right after bootout, without waiting for the job to go", async () => {
    await withHome(async (home) => {
      const sleeps: number[] = []
      const { host, calls } = fakeHost("darwin", home, (argv) =>
        argv[1] === "print" ? ok("state = running\n") : undefined,
      )
      host.sleep = async (ms) => {
        sleeps.push(ms)
      }
      await suspendService(SPEC.id, SPEC.label, host)
      expect(calls).toEqual([
        ["launchctl", "disable", TARGET],
        ["launchctl", "bootout", TARGET],
      ])
      expect(sleeps).toEqual([])
    })
  })

  test.each(["darwin", "linux"] as const)("%s tolerates an already absent job or timer", async (platform) => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost(platform, home, (argv) => {
        if (argv[1] === "bootout") return failed(113, "Could not find service")
        if (argv[0] === "systemctl") return failed(1, `Unit file ${TIMER} does not exist.`)
        return ok()
      })
      await suspendService(SPEC.id, SPEC.label, host)
      expect(calls.at(-1)).toEqual(
        platform === "darwin" ? ["launchctl", "bootout", TARGET] : ["systemctl", "--user", "disable", "--now", TIMER],
      )
    })
  })

  test("systemd maps a real disable failure without stopping the service", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("linux", home, () => failed(1, "permission denied"))
      await expect(suspendService(SPEC.id, SPEC.label, host)).rejects.toThrow("permission denied")
      expect(calls).toEqual([["systemctl", "--user", "disable", "--now", TIMER]])
    })
  })
})
