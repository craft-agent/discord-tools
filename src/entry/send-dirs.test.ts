import { describe, expect, test } from "bun:test"
import { delimiter, resolve } from "node:path"
import { isToolError } from "../core"
import { resolveSendDirs, resolveSendMaxMb } from "./send-dirs"

function refusal(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the setting to be rejected")
}

describe("resolveSendDirs", () => {
  test("returns undefined when unset or empty", () => {
    expect(resolveSendDirs(undefined, {})).toBeUndefined()
    expect(resolveSendDirs({ text: "", source: "--send-dirs" }, {})).toBeUndefined()
    expect(resolveSendDirs({ text: `  ${delimiter} ${delimiter} `, source: "--send-dirs" }, {})).toBeUndefined()
    expect(resolveSendDirs({ entries: [], source: 'Option "send_dirs"' }, {})).toBeUndefined()
    expect(resolveSendDirs({ entries: ["", "   "], source: 'Option "send_dirs"' }, {})).toBeUndefined()
  })

  test("splits delimited text, trims entries, drops blanks, and preserves commas inside paths", () => {
    const text = ` /var/send,one ${delimiter}${delimiter} /var/send,two `
    expect(resolveSendDirs({ text, source: "--send-dirs" }, {})).toEqual([
      resolve("/var/send,one"),
      resolve("/var/send,two"),
    ])
  })

  test("resolves string entries without splitting on the path-list delimiter", () => {
    const entries = ["/var/send:one", " /var/send:two ", ""]
    expect(resolveSendDirs({ entries, source: 'Option "send_dirs"' }, {})).toEqual([
      resolve("/var/send:one"),
      resolve("/var/send:two"),
    ])
  })

  test("expands ~ and ~/x against the home directory", () => {
    const env = { HOME: "/home/user" }
    expect(resolveSendDirs({ text: `~${delimiter}~/files`, source: "--send-dirs" }, env)).toEqual([
      "/home/user",
      resolve("/home/user", "files"),
    ])
  })

  test("refuses a relative or ~otheruser path and names the source", () => {
    for (const text of ["relative/path", "~otheruser/x", `/abs/one${delimiter}relative/two`]) {
      const error = refusal(() => resolveSendDirs({ text, source: "DEMO_SEND_DIRS" }, { HOME: "/h" }))
      expect(error.message).toContain("DEMO_SEND_DIRS")
      expect(error.message).toContain("must be an absolute path")
    }
  })

  test("allows up to 20 directories and refuses 21", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `/dir/${i}`)
    expect(resolveSendDirs({ entries: [...twenty, "  "], source: "--send-dirs" }, {})).toEqual(twenty)
    const error = refusal(() =>
      resolveSendDirs({ text: [...twenty, "/dir/20"].join(delimiter), source: "DEMO_SEND_DIRS" }, {}),
    )
    expect(error.message).toContain("DEMO_SEND_DIRS")
    expect(error.message).toContain("20")
  })
})

describe("resolveSendMaxMb", () => {
  test("defaults to 10", () => {
    expect(resolveSendMaxMb(undefined)).toBe(10)
  })

  test("accepts whole numbers from 1 to 500", () => {
    for (const [text, expected] of [
      ["1", 1],
      [" 250 ", 250],
      ["500", 500],
    ] as const) {
      expect(resolveSendMaxMb({ text, source: "--send-max-mb" })).toBe(expected)
    }
  })

  test("refuses anything else", () => {
    for (const text of ["0", "501", "-1", "1.5", "1e2", "abc", "", "0x10"]) {
      expect(refusal(() => resolveSendMaxMb({ text, source: "--send-max-mb" })).message).toBe(
        "send_max_mb must be a whole number from 1 to 500",
      )
    }
  })
})
