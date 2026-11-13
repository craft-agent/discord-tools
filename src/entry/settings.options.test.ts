import { describe, expect, test } from "bun:test"
import { settingsFromOptions } from "./settings"
import { DEFAULT_DOWNLOADS, DEFAULT_GRANTS, failure, profile, resolved } from "./settings.testing"

const fromOptions = (options: Record<string, unknown> | undefined, env: Record<string, string | undefined> = {}) =>
  settingsFromOptions(options, env, profile)

describe("settingsFromOptions", () => {
  test("gives no setting for no options", () => {
    const none = { options: {}, state_dir: expect.any(String), ...DEFAULT_DOWNLOADS, grants: DEFAULT_GRANTS }
    expect(fromOptions(undefined)).toEqual(none)
    expect(fromOptions({})).toEqual(none)
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
      ...resolved({
        state_dir: "/custom/state",
        download_dir: "/custom/downloads",
        download_max_mb: 250,
        send_dirs: ["/custom/send1", "/custom/send2"],
        send_max_mb: 25,
      }),
      grants: DEFAULT_GRANTS,
    })
    expect(fromOptions({ send_dirs: ["/single/send"] }).send_dirs).toEqual(["/single/send"])
    expect(fromOptions({ send_dirs: [] }).send_dirs).toBeUndefined()
    expect(fromOptions({ send_dirs: ["/a", "", "  ", "/b"] }).send_dirs).toEqual(["/a", "/b"])
    expect(fromOptions({ state_dir: " ", download_dir: "" }, {})).toEqual(fromOptions({}))
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
      DEMO_SEND_DIRS: "/env/send1,/env/send2",
      DEMO_SEND_MAX_MB: "15",
    }
    expect(fromOptions({}, env)).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a", "b"],
      ...resolved({
        state_dir: "/env/state",
        download_dir: "/env/downloads",
        download_max_mb: 30,
        send_dirs: ["/env/send1", "/env/send2"],
        send_max_mb: 15,
      }),
      grants: DEFAULT_GRANTS,
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
      ...resolved({
        state_dir: "/opt/state",
        download_dir: "/opt/get",
        download_max_mb: 5,
        send_dirs: ["/opt/send1", "/opt/send2"],
        send_max_mb: 8,
      }),
      grants: DEFAULT_GRANTS,
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
    for (const value of [true, "100", ["5"], Number.NaN]) {
      expect(failure(() => fromOptions({ download_max_mb: value })).message).toBe(
        'Option "download_max_mb" must be a finite number.',
      )
      expect(failure(() => fromOptions({ send_max_mb: value })).message).toBe(
        'Option "send_max_mb" must be a finite number.',
      )
    }
    for (const value of [0, 501, 1.5]) {
      expect(failure(() => fromOptions({ download_max_mb: value })).message).toBe(
        'Option "download_max_mb" must be a whole number from 1 to 500.',
      )
      expect(failure(() => fromOptions({ send_max_mb: value })).message).toBe(
        'Option "send_max_mb" must be a whole number from 1 to 500.',
      )
    }
    for (const value of [123, "/single/send", [123]]) {
      expect(failure(() => fromOptions({ send_dirs: value })).message).toBe(
        'Option "send_dirs" must be a list of absolute paths.',
      )
    }
    expect(failure(() => fromOptions({ send_dirs: ["relative"] })).message).toBe(
      'Option "send_dirs" must be an absolute path.',
    )
    expect(failure(() => fromOptions({ send_dirs: ["/abs", "relative"] })).message).toBe(
      'Option "send_dirs" must be an absolute path.',
    )
    const twentyOne = Array.from({ length: 21 }, (_, i) => `/dir/${i}`)
    expect(failure(() => fromOptions({ send_dirs: twentyOne })).message).toBe(
      'Option "send_dirs" must list at most 20 items.',
    )
    expect(fromOptions({ send_dirs: [...twentyOne.slice(0, 20), " "] }).send_dirs).toHaveLength(20)
  })

  test("an unknown toolset or option is rejected, naming it", () => {
    const toolset = failure(() => fromOptions({ toolsets: ["bogus"] })).message
    expect(toolset).toContain('"bogus"')
    expect(toolset).toContain('option "toolsets"')
    expect(failure(() => fromOptions({ confirm: "harness" })).message).toContain('"confirm"')
    const unknown = failure(() => fromOptions({ nope: 1 })).message
    for (const name of ["toolsets", "state_dir", "download_max_mb", "send_dirs", "send_max_mb", "note_text"]) {
      expect(unknown).toContain(name)
    }
  })

  test("a bad environment variable is rejected only when no option overrides it", () => {
    expect(failure(() => fromOptions({}, { DEMO_READ_ONLY: "yes" })).message).toContain("DEMO_READ_ONLY")
    expect(fromOptions({ read_only: true }, { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })
})
