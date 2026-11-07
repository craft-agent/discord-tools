import { describe, expect, test } from "bun:test"
import { unlink } from "node:fs/promises"
import { installSystemdService as installService, systemdServiceStatus as serviceStatus } from "./service-systemd"
import { failed, fakeHost, ok, SPEC, withHome } from "./service.testing"

const SERVICE = "io-example-tools-default.service"
const TIMER = "io-example-tools-default.timer"

/** The `systemctl show` output of a unit. */
function show(properties: Record<string, string>): string {
  return Object.entries(properties)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")
}

/** A host whose timer and service answer `show` with the given properties. */
function units(timer: Record<string, string>, service: Record<string, string>) {
  return (argv: string[]) => (argv[2] === "show" ? ok(show(argv[3] === TIMER ? timer : service)) : undefined)
}

const ACTIVE_TIMER = { LoadState: "loaded", ActiveState: "active" }

describe("systemd service status", () => {
  test("queries both units for the needed properties", async () => {
    await withHome(async (home) => {
      await installService(SPEC, fakeHost("linux", home).host)
      const { host, calls } = fakeHost("linux", home, units(ACTIVE_TIMER, { LoadState: "loaded" }))
      await serviceStatus(SPEC.id, SPEC.label, host)
      const properties = ["LoadState", "ActiveState", "MainPID", "ExecMainStatus", "ExecMainStartTimestampMonotonic"]
      const flags = properties.flatMap((name) => ["-p", name])
      expect(calls).toEqual([
        ["systemctl", "--user", "show", TIMER, ...flags],
        ["systemctl", "--user", "show", SERVICE, ...flags],
      ])
    })
  })

  test("a waiting timer is healthy even when the service is inactive", async () => {
    await withHome(async (home) => {
      await installService(SPEC, fakeHost("linux", home).host)
      const service = { LoadState: "loaded", ActiveState: "inactive", MainPID: "0", ExecMainStatus: "0" }
      const { host } = fakeHost(
        "linux",
        home,
        units(ACTIVE_TIMER, { ...service, ExecMainStartTimestampMonotonic: "55" }),
      )
      const status = await serviceStatus(SPEC.id, SPEC.label, host)
      expect(status).toMatchObject({ installed: true, scheduled: true, running: false, lastExit: 0 })
      expect(status.timer).toContain(TIMER)
      expect(status.pid).toBeUndefined()
    })
  })

  test("a run in progress is running with its pid; a failed previous run reports its exit", async () => {
    await withHome(async (home) => {
      await installService(SPEC, fakeHost("linux", home).host)
      const base = { LoadState: "loaded", ExecMainStartTimestampMonotonic: "9" }
      const active = { ...base, ActiveState: "active", MainPID: "9876", ExecMainStatus: "0" }
      const run = await serviceStatus(SPEC.id, SPEC.label, fakeHost("linux", home, units(ACTIVE_TIMER, active)).host)
      expect(run).toMatchObject({ scheduled: true, running: true, pid: 9876 })
      expect(run.lastExit).toBeUndefined()

      const activating = { ...active, ActiveState: "activating" }
      const starting = fakeHost("linux", home, units(ACTIVE_TIMER, activating))
      expect((await serviceStatus(SPEC.id, SPEC.label, starting.host)).running).toBe(true)

      const noPid = { ...active, MainPID: "0" }
      expect(
        (await serviceStatus(SPEC.id, SPEC.label, fakeHost("linux", home, units(ACTIVE_TIMER, noPid)).host)).running,
      ).toBe(false)

      const crashed = { ...base, ActiveState: "failed", MainPID: "0", ExecMainStatus: "2" }
      const failedRun = await serviceStatus(
        SPEC.id,
        SPEC.label,
        fakeHost("linux", home, units(ACTIVE_TIMER, crashed)).host,
      )
      expect(failedRun).toMatchObject({ running: false, lastExit: 2 })
    })
  })

  test("a service that never ran has no last exit, and an inactive timer is not scheduled", async () => {
    await withHome(async (home) => {
      await installService(SPEC, fakeHost("linux", home).host)
      const fresh = {
        LoadState: "loaded",
        ActiveState: "inactive",
        ExecMainStatus: "0",
        ExecMainStartTimestampMonotonic: "0",
      }
      const stopped = { LoadState: "loaded", ActiveState: "inactive" }
      const { host } = fakeHost("linux", home, units(stopped, fresh))
      const status = await serviceStatus(SPEC.id, SPEC.label, host)
      expect(status).toMatchObject({ installed: true, scheduled: false, running: false })
      expect(status.lastExit).toBeUndefined()
    })
  })

  test("missing files still query both units and report loaded orphan jobs", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost(
        "linux",
        home,
        units(ACTIVE_TIMER, {
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "42",
        }),
      )
      expect(await serviceStatus(SPEC.id, SPEC.label, host)).toMatchObject({
        installed: false,
        scheduled: true,
        running: true,
        pid: 42,
      })
      expect(calls.map((argv) => argv[3])).toEqual([TIMER, SERVICE])
    })
  })

  test.each(["file", "timer"] as const)(
    "a missing %s makes installation incomplete but keeps scheduler state",
    async (missing) => {
      await withHome(async (home) => {
        const paths = await installService(SPEC, fakeHost("linux", home).host)
        await unlink(paths[missing]!)
        const { host } = fakeHost("linux", home, units(ACTIVE_TIMER, { LoadState: "loaded" }))
        expect(await serviceStatus(SPEC.id, SPEC.label, host)).toMatchObject({ installed: false, scheduled: true })
      })
    },
  )

  test("nonzero show results tolerate only confirmed missing units", async () => {
    await withHome(async (home) => {
      const { host, calls } = fakeHost("linux", home, (argv) =>
        argv[3] === TIMER
          ? { code: 4, stdout: "LoadState=not-found\n", stderr: "" }
          : failed(1, `Unit ${SERVICE} could not be found.`),
      )
      const status = await serviceStatus(SPEC.id, SPEC.label, host)
      expect(status).toMatchObject({ installed: false, scheduled: false, running: false })
      expect(status.lastExit).toBeUndefined()
      expect(calls).toHaveLength(2)
    })
  })

  test("an absent service never exposes stale execution properties", async () => {
    await withHome(async (home) => {
      const { host } = fakeHost(
        "linux",
        home,
        units(ACTIVE_TIMER, {
          LoadState: "not-found",
          ActiveState: "inactive",
          ExecMainStatus: "7",
          ExecMainStartTimestampMonotonic: "99",
        }),
      )
      expect((await serviceStatus(SPEC.id, SPEC.label, host)).lastExit).toBeUndefined()
    })
  })

  test("absence text cannot hide a killed, timed-out or negative-code show", async () => {
    await withHome(async (home) => {
      for (const result of [
        { code: -1, stdout: "LoadState=not-found\n", stderr: "" },
        { code: 1, stdout: "LoadState=not-found\n", stderr: "", timedOut: true as const },
        { code: 1, stdout: "", stderr: `Unit ${TIMER} not loaded.`, signal: "SIGTERM" as const },
      ]) {
        await expect(serviceStatus(SPEC.id, SPEC.label, fakeHost("linux", home, () => result).host)).rejects.toThrow()
      }
    })
  })

  test("systemctl failures propagate instead of reading as missing", async () => {
    await withHome(async (home) => {
      await installService(SPEC, fakeHost("linux", home).host)
      const bus = fakeHost("linux", home, () => failed(1, "Failed to connect to bus: not found"))
      await expect(serviceStatus(SPEC.id, SPEC.label, bus.host)).rejects.toThrow("Failed to connect to bus")
      const otherUnit = fakeHost("linux", home, () => failed(1, "Unit another.timer not found."))
      await expect(serviceStatus(SPEC.id, SPEC.label, otherUnit.host)).rejects.toThrow("another.timer")
      const timeout = fakeHost("linux", home, () => ({ code: -1, stdout: "", stderr: "", timedOut: true as const }))
      await expect(serviceStatus(SPEC.id, SPEC.label, timeout.host)).rejects.toThrow("timed out")
    })
  })
})
