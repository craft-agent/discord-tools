import { describe, expect, test } from "bun:test"
import { delimiter } from "node:path"
import { settingsFromOptions } from "./settings"
import { DEFAULT_DOWNLOADS, failure, profile } from "./settings.testing"

const fromOptions = (options: Record<string, unknown> | undefined, env: Record<string, string | undefined> = {}) =>
  settingsFromOptions(options, env, profile)

describe("settingsFromOptions", () => {
  test("gives no setting for no options", () => {
    expect(fromOptions(undefined)).toEqual({ state_dir: expect.any(String), ...DEFAULT_DOWNLOADS })
    expect(fromOptions({})).toEqual({ state_dir: expect.any(String), ...DEFAULT_DOWNLOADS })
  })

  test("reads each option", () => {
    expect(
      fromOptions({
        toolsets: ["alpha", "beta"],
        read_only: true,
        tools: ["demo_thing_read"],
        exclude_tools: ["a"],
        state_dir: "/custom/state",
        download_dir: "/custom/downloads",
        download_max_mb: 250,
        send_dirs: ["/custom/send1", "/custom/send2"],
        send_max_mb: 25,
      }),
    ).toEqual({
      toolsets: ["alpha", "beta"],
      read_only: true,
      tools: ["demo_thing_read"],
      exclude_tools: ["a"],
      state_dir: "/custom/state",
      download_dir: "/custom/downloads",
      download_max_mb: 250,
      send_dirs: ["/custom/send1", "/custom/send2"],
      send_max_mb: 25,
    })
    expect(fromOptions({ download_max_mb: "42" }).download_max_mb).toBe(42)
    expect(fromOptions({ send_max_mb: "18" }).send_max_mb).toBe(18)
    expect(fromOptions({ send_dirs: "/single/send" }).send_dirs).toEqual(["/single/send"])
    expect(fromOptions({ send_dirs: [] }).send_dirs).toBeUndefined()
    expect(fromOptions({ toolsets: "all" }).toolsets).toBe("all")
    expect(fromOptions({ toolsets: ["alpha", "all"] }).toolsets).toBe("all")
    expect(fromOptions({ toolsets: [] }).toolsets).toBeUndefined()
  })

  test("falls back to the environment, and an option wins over it", () => {
    const env = {
      DEMO_TOOLSETS: "gamma",
      DEMO_READ_ONLY: "true",
      DEMO_TOOLS: "a,b",
      DEMO_STATE_DIR: "/env/state",
      DEMO_DOWNLOAD_DIR: "/env/downloads",
      DEMO_DOWNLOAD_MAX_MB: "30",
      DEMO_SEND_DIRS: ["/env/send1", "/env/send2"].join(delimiter),
      DEMO_SEND_MAX_MB: "15",
    }
    expect(fromOptions({}, env)).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a", "b"],
      state_dir: "/env/state",
      download_dir: "/env/downloads",
      download_max_mb: 30,
      send_dirs: ["/env/send1", "/env/send2"],
      send_max_mb: 15,
    })
    expect(
      fromOptions(
        {
          toolsets: ["beta"],
          read_only: false,
          state_dir: "/opt/state",
          download_dir: "/opt/get",
          download_max_mb: 5,
          send_dirs: ["/opt/send1", "/opt/send2"],
          send_max_mb: 8,
        },
        { ...env, DEMO_READ_ONLY: "yes" },
      ),
    ).toEqual({
      toolsets: ["beta"],
      read_only: false,
      tools: ["a", "b"],
      state_dir: "/opt/state",
      download_dir: "/opt/get",
      download_max_mb: 5,
      send_dirs: ["/opt/send1", "/opt/send2"],
      send_max_mb: 8,
    })
  })

  test("an option of the wrong type is rejected, naming it", () => {
    expect(failure(() => fromOptions({ toolsets: "alpha" })).message).toContain('"toolsets"')
    expect(failure(() => fromOptions({ toolsets: [1] })).message).toContain('"toolsets"')
    expect(failure(() => fromOptions({ read_only: "true" })).message).toContain('"read_only"')
    expect(failure(() => fromOptions({ tools: "a" })).message).toContain('"tools"')
    expect(failure(() => fromOptions({ exclude_tools: [null] })).message).toContain('"exclude_tools"')
    expect(failure(() => fromOptions({ state_dir: 123 })).message).toContain('"state_dir"')
    expect(failure(() => fromOptions({ state_dir: false })).message).toContain('"state_dir"')
    expect(failure(() => fromOptions({ state_dir: "relative" })).message).toContain('"state_dir"')
    expect(failure(() => fromOptions({ download_dir: 123 })).message).toContain('"download_dir"')
    expect(failure(() => fromOptions({ download_dir: "relative" })).message).toContain('"download_dir"')
    for (const value of [true, 0, 501, 1.5, "abc", ["5"]]) {
      expect(failure(() => fromOptions({ download_max_mb: value })).message).toContain("download_max_mb")
      expect(failure(() => fromOptions({ send_max_mb: value })).message).toContain("send_max_mb")
    }
    expect(failure(() => fromOptions({ send_dirs: 123 })).message).toContain('"send_dirs"')
    expect(failure(() => fromOptions({ send_dirs: [123] })).message).toContain('"send_dirs"')
    expect(failure(() => fromOptions({ send_dirs: "relative" })).message).toContain('"send_dirs"')
    expect(failure(() => fromOptions({ send_dirs: ["/abs", "relative"] })).message).toContain('"send_dirs"')
  })

  test("an unknown toolset or option is rejected, naming it", () => {
    const toolset = failure(() => fromOptions({ toolsets: ["bogus"] })).message
    expect(toolset).toContain('"bogus"')
    expect(toolset).toContain('option "toolsets"')
    expect(failure(() => fromOptions({ confirm: "harness" })).message).toContain('"confirm"')
  })

  test("a bad environment variable is rejected only when no option overrides it", () => {
    expect(failure(() => fromOptions({}, { DEMO_READ_ONLY: "yes" })).message).toContain("DEMO_READ_ONLY")
    expect(fromOptions({ read_only: true }, { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })
})
