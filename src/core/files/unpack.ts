import { basename } from "node:path"
import { unpackArchive } from "../archive/unpack"
import { isAbortError } from "../errors"
import type { SavedFile } from "./schemas"

/** What unpacking needs besides the archive. */
export type UnpackRun = {
  /** Names or folders from the archive's listing; everything when absent. */
  entries?: string[]
  /** Marks the files written as downloaded. */
  mark(paths: string[]): Promise<void>
  signal?: AbortSignal
}

/**
 * Unpacks every archive of `files` that was saved or found already saved, each
 * into a folder beside it, and records the result on the file: `unpacked`, or
 * `unpack_error` with the reason. The archive stays saved either way; only a
 * cancellation is thrown.
 */
export async function unpackSaved(files: SavedFile[], run: UnpackRun): Promise<void> {
  for (const file of files) {
    if (file.archive === undefined || file.path === undefined) continue
    try {
      file.unpacked = await unpackArchive(file.path, basename(file.path), {
        only: run.entries,
        mark: run.mark,
        signal: run.signal,
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      file.unpack_error = error instanceof Error ? error.message : String(error)
    }
  }
}
