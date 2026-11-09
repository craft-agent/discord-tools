import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArchiveFormat } from "./kinds"
import { readEntries, type EntryKind } from "./read"

/** A fresh temporary directory, made on first use, for the files of one test. */
export class Scratch {
  private dir: string | undefined

  /** The path a file of this name has in the directory, which is made if needed. */
  async path(name: string): Promise<string> {
    this.dir ??= await mkdtemp(join(tmpdir(), "archive-test-"))
    return join(this.dir, name)
  }

  /** Writes a file and returns its path. */
  async write(name: string, bytes: Uint8Array | string): Promise<string> {
    const path = await this.path(name)
    await writeFile(path, bytes)
    return path
  }

  async remove(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true })
    this.dir = undefined
  }
}

/** Every entry of an archive file with its data (files only), read in order. */
export async function readAll(
  path: string,
  format: ArchiveFormat,
): Promise<Array<{ name: string; kind: EntryKind; size: number; encrypted: boolean; data: Buffer }>> {
  const all = []
  for await (const entry of readEntries(path, format)) {
    const pieces: Uint8Array[] = []
    if (entry.kind === "file") for await (const piece of entry.read()) pieces.push(piece)
    all.push({
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      encrypted: entry.encrypted,
      data: Buffer.concat(pieces),
    })
  }
  return all
}
