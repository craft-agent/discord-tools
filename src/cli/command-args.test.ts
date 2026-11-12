import { describe, expect, test } from "bun:test"
import { ToolError } from "../core"
import { PROJECT } from "../project"
import { handleCommandError, parseCommandStateDir, parseFlagArgs } from "./command-args"
import { EXIT_FAILED, EXIT_USAGE } from "./command-io"

const SPEC = { values: ["--account"], switches: ["--yes"] } as const

function collect() {
  let stderr = ""
  return { io: { env: {}, stdout: () => {}, stderr: (text: string) => (stderr += text) }, stderr: () => stderr }
}

describe("parseFlagArgs", () => {
  test("takes a value after the flag and after an equals sign", () => {
    expect(parseFlagArgs(["--account", "work"], SPEC).values).toEqual({ "--account": "work" })
    expect(parseFlagArgs(["--account=work"], SPEC).values).toEqual({ "--account": "work" })
  })

  test("takes a switch and leaves everything else in rest, in order", () => {
    const parsed = parseFlagArgs(["--state-dir", "/s", "--yes", "--account", "a", "extra"], SPEC)
    expect(parsed.switches.has("--yes")).toBe(true)
    expect(parsed.rest).toEqual(["--state-dir", "/s", "extra"])
  })

  test.each([
    [["--account"], "--account"],
    [["--account="], "--account"],
    [["--account", "--yes"], "--account"],
    [["--yes=true"], "--yes"],
  ])("%j is a usage error naming the flag", (argv, flag) => {
    expect(() => parseFlagArgs(argv, SPEC)).toThrow(flag)
  })
})

describe("parseCommandStateDir", () => {
  test("reads the flag, then the environment", () => {
    const { io } = collect()
    expect(parseCommandStateDir(["--state-dir", "/flag"], io)).toBe("/flag")
    expect(parseCommandStateDir([], { ...io, env: { [`${PROJECT.envPrefix}_STATE_DIR`]: "/env" } })).toBe("/env")
  })

  test("takes the other directory flags and checks them, but keeps only the state directory", () => {
    const { io } = collect()
    expect(parseCommandStateDir(["--download-dir", "/get", "--send-dirs=/a,/b"], io, "/flag")).toBe("/flag")
    expect(() => parseCommandStateDir(["--download-dir=relative"], io)).toThrow(
      "--download-dir must be an absolute path.",
    )
    expect(() => parseCommandStateDir(["--send-dirs=relative"], io)).toThrow("--send-dirs must be an absolute path.")
  })

  test("reads no size limit, from a flag or a variable", () => {
    const { io } = collect()
    const env = { [`${PROJECT.envPrefix}_DOWNLOAD_MAX_MB`]: "many", [`${PROJECT.envPrefix}_SEND_MAX_MB`]: "0" }
    expect(parseCommandStateDir(["--state-dir", "/flag"], { ...io, env })).toBe("/flag")
    for (const flag of ["--download-max-mb", "--send-max-mb"]) {
      expect(() => parseCommandStateDir([`${flag}=5`], io)).toThrow(`Unknown option "${flag}=5".`)
    }
  })

  test("rejects any other leftover argument", () => {
    const { io } = collect()
    expect(() => parseCommandStateDir(["--nope"], io)).toThrow('Unknown option "--nope".')
    expect(() => parseCommandStateDir(["--read-only"], io)).toThrow('Unknown option "--read-only".')
    expect(() => parseCommandStateDir(["stray"], io)).toThrow('Unknown option "stray".')
  })
})

describe("handleCommandError", () => {
  test("says a tool error on one prefixed line with the token masked, and picks the exit by mode", () => {
    const token = `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`
    const error = new ToolError("not_found", `lost ${token}`)
    const { io, stderr } = collect()
    expect(handleCommandError(error, io)).toBe(EXIT_FAILED)
    expect(stderr()).toBe(`${PROJECT.cli}: lost <token>\n`)
    expect(handleCommandError(error, io, { mode: "usage" })).toBe(EXIT_USAGE)
    expect(handleCommandError(error, io, { mode: "auto" })).toBe(EXIT_FAILED)
    expect(handleCommandError(new ToolError("invalid_argument", "bad"), io, { mode: "auto" })).toBe(EXIT_USAGE)
  })

  test("says an unknown error generically, without its message or stack", () => {
    const { io, stderr } = collect()
    expect(handleCommandError(new TypeError("secret-detail"), io)).toBe(EXIT_FAILED)
    expect(stderr()).not.toContain("secret-detail")
    expect(stderr()).not.toContain("at ")
    expect(stderr()).toStartWith(`${PROJECT.cli}: `)
    expect(stderr().trimEnd().split("\n")).toHaveLength(1)
  })

  test("says a cancellation only when it is given a message", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" })
    const { io, stderr } = collect()
    expect(handleCommandError(abort, io, { abortMessage: "Cancelled." })).toBe(EXIT_FAILED)
    expect(stderr()).toBe(`${PROJECT.cli}: Cancelled.\n`)
  })
})
