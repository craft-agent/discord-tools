import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inTransaction, openMirrorForWrite, type Mirror } from "./mirror"

/** A mirror in a fresh temp directory. */
export type TestMirror = {
  dir: string
  mirror: Mirror
  /** Runs `fn` in a committed transaction, as the sync run does. */
  write<T>(fn: () => T): T
  /** Closes the mirror and removes the directory. */
  close(): void
}

/** Where a test keeps files in a fresh, short temp directory; remove it with `rmSync`. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "dsc-"))
}

/** Opens a new mirror for writing in a temp directory. */
export function createTestMirror(): TestMirror {
  const dir = makeTempDir()
  const mirror = openMirrorForWrite(join(dir, "mirror.sqlite"))
  return {
    dir,
    mirror,
    write: (fn) => inTransaction(mirror, fn),
    close() {
      mirror.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The error a function throws, for a test that checks it; fails when it returns. */
export function errorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the function to throw")
}

type Param = string | number | bigint | null

/** The rows of a query, for a test to check. */
export function rowsOf(mirror: Mirror, sql: string, ...params: Param[]): Record<string, unknown>[] {
  return mirror.prepare(sql).all(...params) as Record<string, unknown>[]
}

/** The first column of every row of a query. */
export function columnOf(mirror: Mirror, sql: string, ...params: Param[]): unknown[] {
  return rowsOf(mirror, sql, ...params).map((row) => Object.values(row)[0])
}

/** Columns that hold ids; selected as text, since a number cannot hold one above 2^53. */
const ID_COLUMNS = ["id", "channel", "server", "author", "parent", "last_message", "ref_message", "ref_channel"]

/** One stored row by id with its id columns as text; `undefined` when missing. */
export function rowById(mirror: Mirror, table: string, id: string): Record<string, unknown> | undefined {
  const names = columnOf(mirror, `SELECT name FROM pragma_table_info('${table}')`) as string[]
  const select = names.map((name) => (ID_COLUMNS.includes(name) ? `CAST(${name} AS TEXT) AS ${name}` : name))
  return rowsOf(mirror, `SELECT ${select.join(", ")} FROM ${table} WHERE id = ?`, BigInt(id))[0]
}

/** The ids of a channel's stored messages, oldest first, as text. */
export function storedMessageIds(mirror: Mirror, channel: string): string[] {
  return columnOf(
    mirror,
    "SELECT CAST(id AS TEXT) FROM messages WHERE channel = ? ORDER BY id",
    BigInt(channel),
  ) as string[]
}
