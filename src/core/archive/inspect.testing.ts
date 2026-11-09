import type { Scratch } from "./archive.testing"
import { inspectArchive, RECEIVED, type ArchiveReport, type InspectOptions } from "./inspect"
import { tarBytes, tarGzBytes, type TarItem } from "./tar.testing"
import { zipBytes, type ZipItem } from "./zip.testing"

/** Inspects a zip made of `items`, saved as `file`. */
export async function inspectZip(
  scratch: Scratch,
  items: ZipItem[],
  options: InspectOptions = RECEIVED,
  file = "a.zip",
): Promise<ArchiveReport | undefined> {
  return inspectArchive(await scratch.write(file, zipBytes(items)), file, options)
}

/** Inspects a tar (or tar.gz) made of `items`, saved as `file`. */
export async function inspectTar(
  scratch: Scratch,
  items: TarItem[],
  options: InspectOptions = RECEIVED,
  file = "a.tar",
): Promise<ArchiveReport | undefined> {
  const bytes = file.endsWith(".tar") ? tarBytes(items) : tarGzBytes(items)
  return inspectArchive(await scratch.write(file, bytes), file, options)
}
