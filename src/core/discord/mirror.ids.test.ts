import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { openMirrorForWrite, type Mirror } from "./mirror"
import type { MessageRow } from "./mirror-rows"
import { columnOf, makeTempDir, rowsOf } from "./mirror.testing"

/** Made-up ids above 2^53 (9007199254740992) that differ only below the precision of a JS number. */
const BELOW = "9007199254740993"
const ABOVE = "9007199254740995"
/** Ids whose text order differs from their numeric order. */
const SHORT = "999999999999999999"
const LONG = "1455024000000000001"

let dir: string
let mirror: Mirror

beforeEach(() => {
  dir = makeTempDir()
  mirror = openMirrorForWrite(join(dir, "mirror.sqlite"))
})

afterEach(() => {
  mirror.close()
  rmSync(dir, { recursive: true, force: true })
})

function insertMessage(id: string, channel: string): void {
  mirror
    .prepare("INSERT INTO messages (id, channel, from_me, created_at, raw, updated) VALUES (?, ?, 0, 0, '{}', 0)")
    .run(BigInt(id), BigInt(channel))
}

describe("ids as INTEGER", () => {
  test("an id above 2^53 round-trips exactly through CAST", () => {
    insertMessage(BELOW, SHORT)
    expect(columnOf(mirror, "SELECT CAST(id AS TEXT) FROM messages")).toEqual([BELOW])
    expect(columnOf(mirror, "SELECT CAST(channel AS TEXT) FROM messages")).toEqual([SHORT])
    expect(columnOf(mirror, "SELECT typeof(id) FROM messages")).toEqual(["integer"])
  })

  test("neighbouring ids above 2^53 stay distinct and are found by an exact lookup", () => {
    insertMessage(BELOW, SHORT)
    insertMessage(ABOVE, SHORT)
    expect(columnOf(mirror, "SELECT CAST(id AS TEXT) FROM messages WHERE id = ?", BigInt(ABOVE))).toEqual([ABOVE])
    expect(columnOf(mirror, "SELECT count(*) FROM messages")).toEqual([2])
  })

  test("ranges compare numerically, not as text", () => {
    insertMessage(LONG, SHORT)
    insertMessage(SHORT, SHORT)
    insertMessage(BELOW, SHORT)
    const ordered = columnOf(
      mirror,
      "SELECT CAST(id AS TEXT) FROM messages WHERE channel = ? ORDER BY id",
      BigInt(SHORT),
    )
    expect(ordered).toEqual([BELOW, SHORT, LONG])
    const above = columnOf(mirror, "SELECT CAST(id AS TEXT) FROM messages WHERE id > ? ORDER BY id", BigInt(BELOW))
    expect(above).toEqual([SHORT, LONG])
    expect(columnOf(mirror, "SELECT CAST(max(id) AS TEXT) FROM messages")).toEqual([LONG])
  })

  test("reading ids back as BigInt gives the same digits", () => {
    insertMessage(ABOVE, SHORT)
    const statement = mirror.prepare("SELECT id FROM messages")
    statement.setReadBigInts(true)
    expect(String((statement.get() as Pick<MessageRow, "id">).id)).toBe(ABOVE)
    expect(rowsOf(mirror, "SELECT CAST(id AS TEXT) AS id FROM messages")).toEqual([{ id: ABOVE }])
  })
})
