import type { ArchiveFormat } from "./kinds"
import type { ArchiveEntry } from "./entry"
import { readTar } from "./tar"
import { readZip } from "./zip"

export { ArchiveUnreadable, type ArchiveEntry, type EntryKind } from "./entry"

/**
 * The entries of an archive file, one at a time, without unpacking anything.
 * Throws `ArchiveUnreadable` for damage or for what is not supported. The file
 * is closed when the iteration ends, also when the consumer stops early.
 * Aborting `signal` ends it with an `AbortError`.
 */
export function readEntries(path: string, format: ArchiveFormat, signal?: AbortSignal): AsyncIterable<ArchiveEntry> {
  return format === "zip" ? readZip(path, signal) : readTar(path, format === "tar.gz", signal)
}
