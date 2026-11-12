import { describe, expect, test } from "bun:test"
import { delimiter } from "node:path"
import { PROJECT } from "../project"
import type { EntryProfile } from "./profile"
import {
  forwardedVariables,
  parseSettings,
  parseStorageSettings,
  parseTargetSettings,
  parseToolSettings,
  settingVariables,
} from "./settings"
import { NOTE_OPTION } from "./options.testing"
import { DEFAULT_DOWNLOADS, failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)
const parseTool = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseToolSettings(argv, env, profile)

describe("settingVariables", () => {
  test("names each setting's variable under the profile's prefix", () => {
    expect(settingVariables(profile)).toEqual([
      "DEMO_TOOLSETS",
      "DEMO_READ_ONLY",
      "DEMO_TOOLS",
      "DEMO_EXCLUDE_TOOLS",
      "DEMO_CONFIRM",
      "DEMO_STATE_DIR",
      "DEMO_DOWNLOAD_DIR",
      "DEMO_DOWNLOAD_MAX_MB",
      "DEMO_SEND_DIRS",
      "DEMO_SEND_MAX_MB",
      "DEMO_NOTE_TEXT",
    ])
  })

  test("uses the package's own prefix by default", () => {
    expect(settingVariables()).toEqual(
      settingVariables({ ...profile, envPrefix: PROJECT.envPrefix, options: PROJECT.options }),
    )
  })
})

describe("forwardedVariables", () => {
  test("lists the settings' variables, then the tool variables", () => {
    expect(forwardedVariables(profile, ["XDG_STATE_HOME"])).toEqual([...settingVariables(profile), "XDG_STATE_HOME"])
  })

  test("uses the package's own prefix and toolVariables by default", () => {
    expect(forwardedVariables()).toEqual([...settingVariables(), ...PROJECT.toolVariables])
  })
})

describe("parseSettings", () => {
  test("defaults to the harness confirming and no other setting", () => {
    expect(parse([])).toEqual({
      confirm: "harness",
      options: {},
      state_dir: expect.any(String),
      ...DEFAULT_DOWNLOADS,
    })
  })

  test("reads each flag", () => {
    expect(
      parse([
        "--toolsets",
        "alpha,beta",
        "--read-only",
        "--tools",
        "demo_thing_read",
        "--exclude-tools",
        "demo_thing_merge",
        "--confirm",
        "elicitation",
        "--state-dir",
        "/custom/state",
        "--download-dir",
        "/custom/downloads",
        "--download-max-mb",
        "250",
        "--send-dirs",
        ["/custom/send1", "/custom/send2"].join(delimiter),
        "--send-max-mb",
        "25",
      ]),
    ).toEqual({
      toolsets: ["alpha", "beta"],
      read_only: true,
      tools: ["demo_thing_read"],
      exclude_tools: ["demo_thing_merge"],
      confirm: "elicitation",
      options: {},
      state_dir: "/custom/state",
      download_dir: "/custom/downloads",
      download_max_mb: 250,
      send_dirs: ["/custom/send1", "/custom/send2"],
      send_max_mb: 25,
    })
  })

  test("reads the --flag=value form", () => {
    expect(
      parse([
        "--toolsets=gamma",
        "--tools=a,b",
        "--exclude-tools=c",
        "--confirm=elicitation",
        "--read-only",
        "--state-dir=/custom/state",
        "--download-dir=/custom/downloads",
        "--download-max-mb=7",
        `--send-dirs=${["/custom/send1", "/custom/send2"].join(delimiter)}`,
        "--send-max-mb=8",
      ]),
    ).toEqual({
      toolsets: ["gamma"],
      tools: ["a", "b"],
      exclude_tools: ["c"],
      read_only: true,
      confirm: "elicitation",
      options: {},
      state_dir: "/custom/state",
      download_dir: "/custom/downloads",
      download_max_mb: 7,
      send_dirs: ["/custom/send1", "/custom/send2"],
      send_max_mb: 8,
    })
  })

  test("falls back to the environment", () => {
    expect(
      parse([], {
        DEMO_TOOLSETS: "beta,gamma",
        DEMO_READ_ONLY: "true",
        DEMO_TOOLS: "x",
        DEMO_EXCLUDE_TOOLS: "y,z",
        DEMO_CONFIRM: "elicitation",
        DEMO_STATE_DIR: "/env/state",
        DEMO_DOWNLOAD_DIR: "/env/downloads",
        DEMO_DOWNLOAD_MAX_MB: "30",
        DEMO_SEND_DIRS: ["/env/send1", "/env/send2"].join(delimiter),
        DEMO_SEND_MAX_MB: "12",
      }),
    ).toEqual({
      toolsets: ["beta", "gamma"],
      read_only: true,
      tools: ["x"],
      exclude_tools: ["y", "z"],
      confirm: "elicitation",
      options: {},
      state_dir: "/env/state",
      download_dir: "/env/downloads",
      download_max_mb: 30,
      send_dirs: ["/env/send1", "/env/send2"],
      send_max_mb: 12,
    })
  })

  test("names its environment variables after the package's prefix unless given a profile", () => {
    const variable = `${PROJECT.envPrefix}_READ_ONLY`
    expect(parseSettings([], { [variable]: "true" }).read_only).toBe(true)
    expect(parseSettings([], { DEMO_READ_ONLY: "true" }).read_only).toBeUndefined()
    expect(parse([], { [variable]: "true" }).read_only).toBeUndefined()
    expect(failure(() => parseSettings([], { [variable]: "yes" })).message).toContain(variable)
  })

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["False", false],
  ])("DEMO_READ_ONLY=%s is %p", (value, expected) => {
    expect(parse([], { DEMO_READ_ONLY: value }).read_only).toBe(expected)
  })

  test.each(["yes", "on", "2", "enabled"])("DEMO_READ_ONLY=%s is rejected, naming the variable", (value) => {
    const message = failure(() => parse([], { DEMO_READ_ONLY: value })).message
    expect(message).toContain("DEMO_READ_ONLY")
    expect(message).toContain(`"${value}"`)
  })

  test("a flag-given --read-only is not blocked by a bad environment variable it overrides", () => {
    expect(parse(["--read-only"], { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })

  test("a flag wins over its environment variable", () => {
    const env = {
      DEMO_TOOLSETS: "gamma",
      DEMO_TOOLS: "x",
      DEMO_EXCLUDE_TOOLS: "y",
      DEMO_CONFIRM: "elicitation",
      DEMO_READ_ONLY: "0",
      DEMO_STATE_DIR: "/env/state",
      DEMO_DOWNLOAD_DIR: "/env/downloads",
      DEMO_DOWNLOAD_MAX_MB: "30",
      DEMO_SEND_DIRS: "/env/send",
      DEMO_SEND_MAX_MB: "20",
    }
    expect(
      parse(
        [
          "--toolsets",
          "alpha",
          "--tools",
          "a",
          "--exclude-tools",
          "b",
          "--confirm",
          "harness",
          "--read-only",
          "--state-dir",
          "/flag/state",
          "--download-dir",
          "/flag/downloads",
          "--download-max-mb",
          "5",
          "--send-dirs",
          ["/flag/send1", "/flag/send2"].join(delimiter),
          "--send-max-mb",
          "6",
        ],
        env,
      ),
    ).toEqual({
      toolsets: ["alpha"],
      tools: ["a"],
      exclude_tools: ["b"],
      confirm: "harness",
      read_only: true,
      options: {},
      state_dir: "/flag/state",
      download_dir: "/flag/downloads",
      download_max_mb: 5,
      send_dirs: ["/flag/send1", "/flag/send2"],
      send_max_mb: 6,
    })
  })

  test("an empty environment variable counts as unset", () => {
    expect(parse([], { DEMO_TOOLSETS: "", DEMO_CONFIRM: " ", DEMO_DOWNLOAD_MAX_MB: "" })).toEqual({
      confirm: "harness",
      options: {},
      state_dir: expect.any(String),
      ...DEFAULT_DOWNLOADS,
    })
  })

  test("rejects a relative state_dir in flag or environment", () => {
    expect(failure(() => parse(["--state-dir", "rel/path"])).message).toContain("--state-dir")
    expect(failure(() => parse([], { DEMO_STATE_DIR: "rel/path" })).message).toContain("DEMO_STATE_DIR")
  })

  test("rejects a relative download_dir in flag or environment", () => {
    expect(failure(() => parse(["--download-dir", "rel/path"])).message).toContain("--download-dir")
    expect(failure(() => parse([], { DEMO_DOWNLOAD_DIR: "rel/path" })).message).toContain("DEMO_DOWNLOAD_DIR")
  })

  test("rejects a download_max_mb that is not a whole number from 1 to 500", () => {
    for (const text of ["0", "501", "1.5", "many"]) {
      const message = "download_max_mb must be a whole number from 1 to 500"
      expect(failure(() => parse(["--download-max-mb", text])).message).toBe(message)
      expect(failure(() => parse([], { DEMO_DOWNLOAD_MAX_MB: text })).message).toBe(message)
    }
  })

  test("rejects a relative send_dirs in flag or environment", () => {
    expect(failure(() => parse(["--send-dirs", "rel/path"])).message).toContain("--send-dirs")
    expect(failure(() => parse([], { DEMO_SEND_DIRS: "rel/path" })).message).toContain("DEMO_SEND_DIRS")
  })

  test("rejects a send_max_mb that is not a whole number from 1 to 500", () => {
    for (const text of ["0", "501", "1.5", "many"]) {
      const message = "send_max_mb must be a whole number from 1 to 500"
      expect(failure(() => parse(["--send-max-mb", text])).message).toBe(message)
      expect(failure(() => parse([], { DEMO_SEND_MAX_MB: text })).message).toBe(message)
    }
  })

  test("drops empty list items", () => {
    const settings = parse(["--toolsets", "alpha,,beta,", "--tools", ",a, ,b"])
    expect(settings.toolsets).toEqual(["alpha", "beta"])
    expect(settings.tools).toEqual(["a", "b"])
    expect(parse(["--toolsets", ","]).toolsets).toBeUndefined()
  })

  test('"all" turns on every toolset', () => {
    expect(parse(["--toolsets", "all"]).toolsets).toBe("all")
    expect(parse([], { DEMO_TOOLSETS: "all" }).toolsets).toBe("all")
  })

  test("the last of a repeated flag wins", () => {
    expect(parse(["--confirm", "elicitation", "--confirm=harness"]).confirm).toBe("harness")
  })

  test("an unknown flag or a stray argument is rejected, naming it", () => {
    expect(failure(() => parse(["--nope"])).message).toContain("--nope")
    expect(failure(() => parse(["--nope=1"])).message).toContain("--nope=1")
    expect(failure(() => parse(["alpha"])).message).toContain("alpha")
  })

  test("a flag without a value is rejected, naming it", () => {
    expect(failure(() => parse(["--toolsets"])).message).toContain("--toolsets")
    expect(failure(() => parse(["--tools", "--read-only"])).message).toContain("--tools")
    expect(failure(() => parse(["--read-only=1"])).message).toContain("--read-only")
  })

  test("a bad confirm mode is rejected, naming it", () => {
    expect(failure(() => parse(["--confirm", "ask"])).message).toContain('"ask"')
    expect(failure(() => parse([], { DEMO_CONFIRM: "ask" })).message).toContain("DEMO_CONFIRM")
  })

  test("an unknown toolset is rejected, naming it, where it came from and the toolsets there are", () => {
    const fromFlag = failure(() => parse(["--toolsets", "alpha,bogus"])).message
    expect(fromFlag).toContain('"bogus"')
    expect(fromFlag).toContain("--toolsets")
    for (const name of profile.toolsets.names) expect(fromFlag).toContain(name)
    expect(failure(() => parse([], { DEMO_TOOLSETS: "bogus" })).message).toContain("DEMO_TOOLSETS")
  })

  test("with no toolsets defined, a named toolset is rejected and the message says so", () => {
    const none: EntryProfile = {
      name: "demo-tools",
      cli: "demo-tools-cli",
      serviceId: "io.example.demo-tools",
      envPrefix: "DEMO",
      toolsets: { names: [], defaults: [] },
    }
    expect(failure(() => parseSettings(["--toolsets", "alpha"], {}, none)).message).toContain("no toolsets are defined")
    expect(parseSettings(["--toolsets", "all"], {}, none).toolsets).toBe("all")
  })
})

describe("parseToolSettings", () => {
  test("reads the tool settings and gives no confirm setting", () => {
    expect(parseTool([])).toEqual({ options: {}, state_dir: expect.any(String), ...DEFAULT_DOWNLOADS })
    expect(
      parseTool(
        [
          "--toolsets=gamma",
          "--read-only",
          "--tools",
          "a",
          "--state-dir=/tool/state",
          "--download-dir=/tool/get",
          `--send-dirs=${["/tool/send1", "/tool/send2"].join(delimiter)}`,
        ],
        { DEMO_EXCLUDE_TOOLS: "b", DEMO_DOWNLOAD_MAX_MB: "9", DEMO_SEND_MAX_MB: "11" },
      ),
    ).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a"],
      exclude_tools: ["b"],
      options: {},
      state_dir: "/tool/state",
      download_dir: "/tool/get",
      download_max_mb: 9,
      send_dirs: ["/tool/send1", "/tool/send2"],
      send_max_mb: 11,
    })
  })

  test("rejects --confirm in both forms, naming it", () => {
    expect(failure(() => parseTool(["--confirm", "harness"])).message).toContain("--confirm")
    expect(failure(() => parseTool(["--confirm=elicitation"])).message).toContain("--confirm")
  })

  test("ignores DEMO_CONFIRM, even a bad one", () => {
    expect(parseTool([], { DEMO_CONFIRM: "ask" })).toEqual({
      options: {},
      state_dir: expect.any(String),
      ...DEFAULT_DOWNLOADS,
    })
  })
})

describe("parseStorageSettings", () => {
  const parseStorage = (argv: string[], env: Record<string, string | undefined> = {}) =>
    parseStorageSettings(argv, env, profile)

  test("reads --state-dir, --download-dir and --send-dirs, and max_mb settings from the environment", () => {
    expect(
      parseStorage(["--state-dir=/s", "--download-dir", "/d", "--send-dirs", ["/send/a", "/send/b"].join(delimiter)], {
        DEMO_DOWNLOAD_MAX_MB: "12",
        DEMO_SEND_MAX_MB: "15",
      }),
    ).toEqual({
      state_dir: "/s",
      download_dir: "/d",
      download_max_mb: 12,
      send_dirs: ["/send/a", "/send/b"],
      send_max_mb: 15,
    })
    expect(parseStorage([], { DEMO_DOWNLOAD_DIR: "/env/d", DEMO_SEND_DIRS: "/env/send" })).toEqual({
      state_dir: expect.any(String),
      download_dir: "/env/d",
      download_max_mb: 100,
      send_dirs: ["/env/send"],
      send_max_mb: 10,
    })
  })

  test("rejects any other setting flag, naming it", () => {
    for (const flag of ["--read-only", "--download-max-mb=5", "--send-max-mb=5", "--tools=a"]) {
      expect(failure(() => parseStorage([flag])).message).toContain(flag.split("=")[0]!)
    }
  })

  test("rejects the package's own settings' flags, naming them", () => {
    expect(failure(() => parseStorage(["--note-text=x"])).message).toContain("--note-text")
  })
})

describe("parseTargetSettings", () => {
  const parseTarget = (argv: string[], env: Record<string, string | undefined> = {}) =>
    parseTargetSettings(argv, env, profile)

  test("reads the storage flags and the package's own settings together", () => {
    expect(
      parseTarget(["--state-dir=/s", "--note-text", "flag"], { DEMO_DOWNLOAD_MAX_MB: "12", DEMO_NOTE_TEXT: "env" }),
    ).toEqual({
      options: { [NOTE_OPTION]: "flag" },
      state_dir: "/s",
      download_dir: expect.any(String),
      download_max_mb: 12,
      send_max_mb: 10,
    })
    expect(parseTarget([], { DEMO_NOTE_TEXT: "env" }).options).toEqual({ [NOTE_OPTION]: "env" })
    expect(parseTarget([]).options).toEqual({})
  })

  test("rejects every other setting flag, naming it", () => {
    for (const flag of ["--read-only", "--download-max-mb=5", "--send-max-mb=5", "--tools=a", "--toolsets=alpha"]) {
      expect(failure(() => parseTarget([flag])).message).toContain(flag.split("=")[0]!)
    }
  })
})
