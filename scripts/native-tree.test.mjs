import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { checkIntegrity, parseLockfile, PLATFORMS } from "./native-tree.mjs"

const DATA = Buffer.from("made-up tarball")
const INTEGRITY = `sha512-${createHash("sha512").update(DATA).digest("base64")}`
const NAMES = ["wreq-js", ...PLATFORMS.map((platform) => `@wreq-js/binding-${platform}`)]
const ENTRIES = NAMES.map((name, index) => ({ name, version: `1.2.${index}`, integrity: INTEGRITY }))
const PACKAGE_LINES = ENTRIES.map(
  ({ name, version, integrity }) => `  '${name}@${version}':\n    resolution: {integrity: ${integrity}}\n`,
).join("\n")
const LOCKFILE = `lockfileVersion: '9.0'\n\npackages:\n\n${PACKAGE_LINES}\nsnapshots:\n\n  wreq-js@9.9.9: {}\n`

describe("native tree lockfile parsing", () => {
  test("reads each package's resolved version and integrity, not its snapshot", () => {
    expect(parseLockfile(LOCKFILE)).toEqual(ENTRIES)
  })

  test("accepts unquoted package keys", () => {
    expect(parseLockfile(LOCKFILE.replaceAll("'", ""))).toEqual(ENTRIES)
  })

  test("refuses a missing packages section or package", () => {
    expect(() => parseLockfile("snapshots:\n")).toThrow("packages section")
    expect(() => parseLockfile(LOCKFILE.replace("wreq-js@1.2.0", "other@1.2.0"))).toThrow("entry for wreq-js")
  })

  test("refuses ambiguous versions and missing integrity", () => {
    expect(() => parseLockfile(LOCKFILE.replace("snapshots:", `${PACKAGE_LINES}\nsnapshots:`))).toThrow("found 2")
    expect(() => parseLockfile(LOCKFILE.replace(INTEGRITY, "sha256-wrong"))).toThrow("missing sha512 integrity")
  })
})

describe("native tarball integrity", () => {
  test("accepts the lockfile's sha512 digest", () => {
    expect(() => checkIntegrity(DATA, INTEGRITY)).not.toThrow()
  })

  test("refuses changed bytes, a different digest or a different algorithm", () => {
    expect(() => checkIntegrity(Buffer.from("changed"), INTEGRITY)).toThrow("integrity mismatch")
    expect(() => checkIntegrity(DATA, "sha512-wrong")).toThrow("integrity mismatch")
    expect(() => checkIntegrity(DATA, INTEGRITY.replace("sha512", "sha256"))).toThrow("integrity mismatch")
  })
})
