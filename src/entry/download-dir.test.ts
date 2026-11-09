import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { isToolError } from "../core"
import { resolveDownloadDir, resolveDownloadMaxMb } from "./download-dir"
import type { EntryProfile } from "./profile"

const profile: EntryProfile = {
  name: "demo-tools",
  cli: "demo-tools-cli",
  serviceId: "io.example.demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha"], defaults: ["alpha"] },
}

function refusal(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the setting to be rejected")
}

describe("resolveDownloadDir", () => {
  test("returns a resolved absolute path", () => {
    expect(resolveDownloadDir({ text: "/var/get", source: "--download-dir" }, {}, profile)).toBe(resolve("/var/get"))
  })

  test("expands ~ and ~/x against the home directory", () => {
    const env = { HOME: "/home/user" }
    expect(resolveDownloadDir({ text: "~", source: "--download-dir" }, env, profile)).toBe("/home/user")
    expect(resolveDownloadDir({ text: "~/files", source: "--download-dir" }, env, profile)).toBe(
      resolve("/home/user", "files"),
    )
  })

  test("refuses a relative, ~otheruser or blank path and names the source", () => {
    for (const text of ["relative/path", "~otheruser/x", "", "   "]) {
      const error = refusal(() => resolveDownloadDir({ text, source: "DEMO_DOWNLOAD_DIR" }, { HOME: "/h" }, profile))
      expect(error.message).toContain("DEMO_DOWNLOAD_DIR")
      expect(error.message).toContain("must be an absolute path")
    }
  })

  test("defaults to <home>/Downloads/<profile.name>", () => {
    expect(resolveDownloadDir(undefined, { HOME: "/home/user" }, profile)).toBe(
      resolve("/home/user", "Downloads", "demo-tools"),
    )
  })

  test("falls back to homedir() when HOME is unset or relative", () => {
    const expected = resolve(homedir(), "Downloads", "demo-tools")
    expect(resolveDownloadDir(undefined, {}, profile)).toBe(expected)
    expect(resolveDownloadDir(undefined, { HOME: "relative/home" }, profile)).toBe(expected)
  })
})

describe("resolveDownloadMaxMb", () => {
  test("defaults to 100", () => {
    expect(resolveDownloadMaxMb(undefined)).toBe(100)
  })

  test("accepts whole numbers from 1 to 500", () => {
    for (const [text, expected] of [
      ["1", 1],
      [" 250 ", 250],
      ["500", 500],
    ] as const) {
      expect(resolveDownloadMaxMb({ text, source: "--download-max-mb" })).toBe(expected)
    }
  })

  test("refuses anything else", () => {
    for (const text of ["0", "501", "-1", "1.5", "1e2", "abc", "", "0x10"]) {
      expect(refusal(() => resolveDownloadMaxMb({ text, source: "--download-max-mb" })).message).toBe(
        "download_max_mb must be a whole number from 1 to 500",
      )
    }
  })
})
