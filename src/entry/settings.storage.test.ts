import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseSettings, parseToolOptions } from "./settings"
import { failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)

describe("the directory settings", () => {
  const home = { HOME: "/home/user" }

  test("expand ~ and ~/x against the home directory and normalize the path", () => {
    expect(parse(["--state-dir", "~"], home).state_dir).toBe("/home/user")
    expect(parse(["--download-dir=~/files"], home).download_dir).toBe(resolve("/home/user", "files"))
    expect(parse([], { ...home, DEMO_STATE_DIR: "/var/a/../state" }).state_dir).toBe("/var/state")
    expect(parse(["--send-dirs", "~,~/files"], home).send_dirs).toEqual(["/home/user", resolve("/home/user", "files")])
  })

  test("refuse a relative or ~otheruser path, naming the flag or the variable", () => {
    for (const text of ["relative/path", "~otheruser/x"]) {
      expect(failure(() => parse(["--state-dir", text], home)).message).toBe("--state-dir must be an absolute path.")
      expect(failure(() => parse([], { ...home, DEMO_DOWNLOAD_DIR: text })).message).toBe(
        "DEMO_DOWNLOAD_DIR must be an absolute path.",
      )
      expect(failure(() => parse([`--send-dirs=/abs,${text}`], home)).message).toBe(
        "--send-dirs must be an absolute path.",
      )
    }
  })

  test("count a blank value as unset, and a blank flag suppresses its variable", () => {
    const unset = parse([])
    expect(parse(["--state-dir", " ", "--download-dir=", "--send-dirs= , "])).toEqual(unset)
    expect(parse([], { DEMO_STATE_DIR: " ", DEMO_DOWNLOAD_DIR: "", DEMO_SEND_DIRS: ", " })).toEqual(unset)
    expect(parse(["--state-dir="], { DEMO_STATE_DIR: "/env/state" })).toEqual(unset)
  })

  test("read send_dirs as a comma-separated list, dropping blank items and keeping a colon in a path", () => {
    expect(parse(["--send-dirs", " /a/b:c , ,/d"]).send_dirs).toEqual(["/a/b:c", "/d"])
    expect(parse([], { DEMO_SEND_DIRS: "/a,/b" }).send_dirs).toEqual(["/a", "/b"])
  })

  test("allow up to 20 send_dirs and refuse 21", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `/dir/${i}`)
    expect(parse([`--send-dirs=${twenty.join(",")},`]).send_dirs).toEqual(twenty)
    expect(failure(() => parse([`--send-dirs=${[...twenty, "/dir/20"].join(",")}`])).message).toBe(
      "--send-dirs must list at most 20 items.",
    )
    expect(failure(() => parse([], { DEMO_SEND_DIRS: [...twenty, "/dir/20"].join(",") })).message).toBe(
      "DEMO_SEND_DIRS must list at most 20 items.",
    )
  })
})

describe("the size limits", () => {
  test.each([
    ["download_max_mb", "--download-max-mb", "DEMO_DOWNLOAD_MAX_MB"],
    ["send_max_mb", "--send-max-mb", "DEMO_SEND_MAX_MB"],
  ] as const)("%s takes a whole number from 1 to 500", (name, flag, variable) => {
    for (const [text, expected] of [
      ["1", 1],
      [" 250 ", 250],
      ["500", 500],
      ["1e2", 100],
    ] as const) {
      expect(parse([`${flag}=${text}`])[name]).toBe(expected)
      expect(parse([], { [variable]: text })[name]).toBe(expected)
    }
    for (const text of ["0", "501", "-1", "1.5"]) {
      expect(failure(() => parse([`${flag}=${text}`])).message).toBe(`${flag} must be a whole number from 1 to 500.`)
      expect(failure(() => parse([], { [variable]: text })).message).toBe(
        `${variable} must be a whole number from 1 to 500.`,
      )
    }
    for (const text of ["abc", ""]) {
      expect(failure(() => parse([`${flag}=${text}`])).message).toBe(
        `Unknown number "${text}" in ${flag}; use a finite number.`,
      )
    }
  })
})

describe("parseToolOptions with the directory settings", () => {
  test("reads the package's own settings and the tool options, and no other setting", () => {
    expect(
      parseToolOptions(
        ["--state-dir=/s", "--send-max-mb", "5", "--note-text", "flag"],
        { DEMO_DOWNLOAD_MAX_MB: "12" },
        profile,
      ),
    ).toEqual({ state_dir: "/s", send_max_mb: 5, note_text: "flag", download_max_mb: 12 })
    for (const flag of ["--read-only", "--tools=a", "--toolsets=alpha"]) {
      expect(failure(() => parseToolOptions([flag], {}, profile)).message).toBe(
        `Unknown option "${flag.split("=")[0]}".`,
      )
    }
  })
})
