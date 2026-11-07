import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { isToolError } from "../errors"
import { ingestServerList } from "./ingest"
import { getMeta, inTransaction, openMirrorForIngest, openMirrorForWrite, type Mirror } from "./mirror"
import { SERVER_LIST_AT_META } from "./mirror-meta"
import { columnOf, errorOf, makeTempDir } from "./mirror.testing"
import { ctxAt, NOW, SERVER, serverObject } from "./objects.testing"

let dir: string
let path: string
const opened: Mirror[] = []

function tracked(mirror: Mirror): Mirror {
  opened.push(mirror)
  return mirror
}

/** A file whose `user_version` is `version`, with a table so SQLite writes it. */
function writeVersion(version: number): void {
  const raw = new DatabaseSync(path)
  raw.exec(`CREATE TABLE other (x); PRAGMA user_version = ${version}`)
  raw.close()
}

beforeEach(() => {
  dir = makeTempDir()
  path = join(dir, "mirror.sqlite")
})

afterEach(() => {
  for (const mirror of opened.splice(0)) if (mirror.isOpen) mirror.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("openMirrorForIngest", () => {
  test("refuses a missing file as not synced, and creates nothing", () => {
    const error = errorOf(() => openMirrorForIngest(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(error.message).toContain("Nothing has been synced")
    expect(readdirSync(dir)).toEqual([])
  })

  test("refuses a file that was never set up, and does not migrate it", () => {
    writeFileSync(path, "")
    const error = errorOf(() => openMirrorForIngest(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    const raw = new DatabaseSync(path)
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 })
    raw.close()
  })

  test("refuses a newer mirror without creating a WAL file", () => {
    writeVersion(99)
    const error = errorOf(() => openMirrorForIngest(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toContain("newer version")
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  test("writes what an ingest function stores, and leaves the journal mode alone", () => {
    tracked(openMirrorForWrite(path)).close()
    const mirror = tracked(openMirrorForIngest(path))
    inTransaction(mirror, () => ingestServerList(mirror, ctxAt(), [serverObject(SERVER)]))
    expect(getMeta(mirror)[SERVER_LIST_AT_META]).toBe(String(NOW))
    expect(columnOf(mirror, "SELECT CAST(id AS TEXT) FROM servers")).toEqual([SERVER])
    expect(columnOf(mirror, "PRAGMA journal_mode")).toEqual(["wal"])
    const other = tracked(openMirrorForWrite(path))
    expect(columnOf(other, "SELECT CAST(id AS TEXT) FROM servers")).toEqual([SERVER])
  })
})
