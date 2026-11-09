import type { ArchiveFormat } from "./kinds"
import { ArchiveUnreadable, type ArchiveEntry } from "./entry"
import { readZip } from "./zip"

export { ArchiveUnreadable, type ArchiveEntry, type EntryKind } from "./entry"

/**
 * The entries of an archive file, one at a time, without unpacking anything.
 * Throws `ArchiveUnreadable` for damage or for what is not supported. The file
 * is closed when the iteration ends, also when the consumer stops early.
 * Aborting `signal` ends it with an `AbortError`.
 */
export function readEntries(path: string, format: ArchiveFormat, signal?: AbortSignal): AsyncIterable<ArchiveEntry> {
  if (format !== "zip") throw new ArchiveUnreadable(`${format} archives cannot be read yet`)
  return readZip(path, signal)
}
