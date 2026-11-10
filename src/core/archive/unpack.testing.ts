import { lstat, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Scratch } from "./archive.testing"
import { tarBytes, tarGzBytes, type TarItem } from "./tar.testing"
import { unpackArchive, type UnpackOptions, type UnpackResult } from "./unpack"
import { zipBytes, type ZipItem } from "./zip.testing"

/** Saves a zip made of `items` as `file` and returns its path. */
export function saveZip(scratch: Scratch, items: ZipItem[], file = "pack.zip"): Promise<string> {
  return scratch.write(file, zipBytes(items))
}

/** Saves a tar (or tar.gz, by the name) made of `items` as `file` and returns its path. */
export function saveTar(scratch: Scratch, items: TarItem[], file = "pack.tar"): Promise<string> {
  return scratch.write(file, file.endsWith(".tar") ? tarBytes(items) : tarGzBytes(items))
}

/** Saves a zip of `items` as `file` and unpacks it. */
export async function unpackZip(
  scratch: Scratch,
  items: ZipItem[],
  options?: UnpackOptions,
  file = "pack.zip",
): Promise<UnpackResult> {
  return unpackArchive(await saveZip(scratch, items, file), file, options)
}

/** Every path below `folder`, sorted, a folder with a trailing `/`. */
export async function tree(folder: string): Promise<string[]> {
  const found: string[] = []
  for (const name of await readdir(folder, { recursive: true })) {
    found.push((await lstat(join(folder, name))).isDirectory() ? `${name}/` : name)
  }
  return found.sort()
}

/** What is beside a saved archive: everything in its folder. */
export function beside(path: string): Promise<string[]> {
  return tree(dirname(path))
}

/** The permission bits of a path. */
export async function modeOf(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777
}
