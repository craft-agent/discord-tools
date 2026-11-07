import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readJsonFile, writePrivateFile } from "./private-file"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dsc-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("writePrivateFile", () => {
  test("writes the content with mode 600 and leaves nothing else", async () => {
    const path = join(tempDir, "a.json")
    await writePrivateFile(path, '{"a":1}')
    expect(readFileSync(path, "utf8")).toBe('{"a":1}')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(tempDir)).toEqual(["a.json"])
  })

  test("replaces an existing file", async () => {
    const path = join(tempDir, "a.json")
    writeFileSync(path, "old", { mode: 0o644 })
    await writePrivateFile(path, "new")
    expect(readFileSync(path, "utf8")).toBe("new")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("leaves no temporary file when it fails", async () => {
    const dir = join(tempDir, "d")
    mkdirSync(dir)
    const path = join(dir, "target")
    mkdirSync(path)
    writeFileSync(join(path, "keep"), "x")
    await expect(writePrivateFile(path, "data")).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(["target"])
  })
})

describe("readJsonFile", () => {
  test("parses a file", async () => {
    const path = join(tempDir, "a.json")
    writeFileSync(path, '{"a":1}')
    expect(await readJsonFile(path)).toEqual({ a: 1 })
  })

  test("gives undefined for a missing or malformed file", async () => {
    expect(await readJsonFile(join(tempDir, "missing"))).toBeUndefined()
    writeFileSync(join(tempDir, "bad"), "{")
    expect(await readJsonFile(join(tempDir, "bad"))).toBeUndefined()
  })
})
