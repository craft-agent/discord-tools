import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeToken } from "./fake-token.testing"
import { type LabelPaths, ensureLabelDir } from "./labels"
import { clearRejected, recordRejected, rejectedAt, writeTokenFile } from "./token"

const TOKEN = fakeToken()
const OTHER = fakeToken("b")

let tempDir: string
let paths: LabelPaths

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "dsc-"))
  paths = await ensureLabelDir(join(tempDir, "state"), "work")
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("the rejection record", () => {
  test("reads as no record when there is none", async () => {
    expect(await rejectedAt(paths, TOKEN)).toBeUndefined()
  })

  test("returns the time for the same token only", async () => {
    await recordRejected(paths, TOKEN, 1_700_000_000_000)
    expect(await rejectedAt(paths, TOKEN)).toBe(1_700_000_000_000)
    expect(await rejectedAt(paths, OTHER)).toBeUndefined()
  })

  test("is mode 600 and holds a salted fingerprint, never the token", async () => {
    await recordRejected(paths, TOKEN, 5)
    expect(statSync(paths.auth).mode & 0o777).toBe(0o600)
    const text = readFileSync(paths.auth, "utf8")
    expect(text).not.toContain(TOKEN)
    const record = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(["fingerprint", "rejectedAt", "salt"])
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(record.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test("uses a new salt each time", async () => {
    await recordRejected(paths, TOKEN, 1)
    const first = readFileSync(paths.auth, "utf8")
    await recordRejected(paths, TOKEN, 1)
    expect(readFileSync(paths.auth, "utf8")).not.toBe(first)
  })

  test("reads a malformed record as none", async () => {
    for (const text of [
      "",
      "not json",
      "null",
      "[]",
      '{"rejectedAt":"x","salt":"a","fingerprint":"b"}',
      '{"rejectedAt":1}',
    ]) {
      writeFileSync(paths.auth, text)
      expect(await rejectedAt(paths, TOKEN)).toBeUndefined()
    }
  })

  test("clearRejected removes the record and tolerates none", async () => {
    await recordRejected(paths, TOKEN, 1)
    await clearRejected(paths)
    expect(existsSync(paths.auth)).toBe(false)
    await clearRejected(paths)
  })

  test("storing a new token clears the record", async () => {
    await recordRejected(paths, TOKEN, 1)
    await writeTokenFile(paths, OTHER)
    expect(existsSync(paths.auth)).toBe(false)
  })
})
