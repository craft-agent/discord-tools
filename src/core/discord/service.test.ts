import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { fakeToken } from "./fake-token.testing"
import { installService, serviceStatus, suspendService, uninstallService } from "./service"
import { failed, fakeHost, SPEC, withHome } from "./service.testing"
import { checkServiceSpec, defaultServiceHost, isKnownAbsent, mapProgramError } from "./service-types"

async function rejection(promise: Promise<unknown>): Promise<ToolError> {
  return (await promise.catch((error: unknown) => error)) as ToolError
}

describe("service dispatcher", () => {
  test("refuses unsupported platforms with invalid_argument", async () => {
    const { host, calls } = fakeHost("win32", "C:\\Users\\test")
    for (const error of [
      await rejection(installService(SPEC, host)),
      await rejection(uninstallService(SPEC.id, SPEC.label, host)),
      await rejection(suspendService(SPEC.id, SPEC.label, host)),
      await rejection(serviceStatus(SPEC.id, SPEC.label, host)),
    ]) {
      expect(error).toBeInstanceOf(ToolError)
      expect(error.code).toBe("invalid_argument")
    }
    expect(calls).toEqual([])
  })

  test("refuses an unsafe id or label for every operation before running anything", async () => {
    await withHome(async (home) => {
      for (const platform of ["darwin", "linux"] as const) {
        const { host, calls } = fakeHost(platform, home)
        for (const id of ["../evil", "a/b", "a..b", "", ".hidden", "a b"]) {
          expect((await rejection(installService({ ...SPEC, id }, host))).code).toBe("invalid_argument")
          expect((await rejection(uninstallService(id, "default", host))).code).toBe("invalid_argument")
          expect((await rejection(suspendService(id, "default", host))).code).toBe("invalid_argument")
          expect((await rejection(serviceStatus(id, "default", host))).code).toBe("invalid_argument")
        }
        for (const label of ["../x", "Upper", "a/b", ""]) {
          expect((await rejection(installService({ ...SPEC, label }, host))).code).toBe("invalid_argument")
          expect((await rejection(uninstallService(SPEC.id, label, host))).code).toBe("invalid_argument")
          expect((await rejection(suspendService(SPEC.id, label, host))).code).toBe("invalid_argument")
          expect((await rejection(serviceStatus(SPEC.id, label, host))).code).toBe("invalid_argument")
        }
        expect(calls).toEqual([])
      }
    })
  })

  test("refuses a relative home before any side effect", async () => {
    const { host, calls } = fakeHost("linux", "relative/home")
    expect((await rejection(installService(SPEC, host))).code).toBe("internal_error")
    expect((await rejection(serviceStatus(SPEC.id, SPEC.label, host))).code).toBe("internal_error")
    expect((await rejection(suspendService(SPEC.id, SPEC.label, host))).code).toBe("internal_error")
    expect(calls).toEqual([])
  })

  test("checkServiceSpec refuses control characters and a relative program", () => {
    const check = (patch: Partial<typeof SPEC>) => () => checkServiceSpec({ ...SPEC, ...patch }, "/home/u")
    expect(check({ description: "a\nb" })).toThrow("the description")
    expect(check({ program: "/bin/no\0de" })).toThrow("the program")
    expect(check({ args: ["ok", "bad\x1f"] })).toThrow("an argument")
    expect(check({ path: "/bin:\t/usr/bin" })).toThrow("PATH")
    expect(check({ program: "node" })).toThrow("absolute")
    expect(check({})).not.toThrow()
  })

  test("mapProgramError masks tokens, truncates to 300 characters and names a timeout", () => {
    const masked = mapProgramError("systemctl", failed(1, `Error with ${fakeToken()} daemon`))
    expect(masked.code).toBe("upstream_error")
    expect(masked.message).toBe("systemctl failed: Error with <token> daemon")
    expect(mapProgramError("launchctl", failed(1, "x".repeat(350))).message).toBe(
      `launchctl failed: ${"x".repeat(300)}`,
    )
    expect(mapProgramError("launchctl", failed(1, "")).message).toBe("launchctl failed.")
    expect(mapProgramError("launchctl", { code: -1, stdout: "", stderr: "", timedOut: true }).message).toBe(
      "launchctl timed out after 30 seconds.",
    )
  })

  test("isKnownAbsent never treats a timeout, a signal or an unknown failure as absent", () => {
    const known = /not loaded/
    expect(isKnownAbsent(failed(1, "unit not loaded"), known)).toBe(true)
    expect(isKnownAbsent(failed(0, "unit not loaded"), known)).toBe(false)
    expect(isKnownAbsent(failed(-1, "unit not loaded"), known)).toBe(false)
    expect(isKnownAbsent(failed(5, "unit not loaded"), known, [3])).toBe(false)
    expect(isKnownAbsent(failed(1, "permission denied"), known)).toBe(false)
    expect(isKnownAbsent({ code: -1, stdout: "", stderr: "not loaded", timedOut: true }, known)).toBe(false)
    expect(isKnownAbsent({ code: -1, stdout: "", stderr: "not loaded", signal: "SIGKILL" }, known)).toBe(false)
  })

  test("defaultServiceHost gives the process's platform and a run that reports a missing program", async () => {
    const host = defaultServiceHost()
    expect(host.platform).toBe(process.platform)
    expect(host.home.startsWith("/")).toBe(true)
    const error = await rejection(host.run(["/nonexistent/service-program"]))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("/nonexistent/service-program could not be started")
  })
})
