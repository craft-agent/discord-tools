import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { isAbortError } from "../errors"
import { abortError } from "../exec"

/** The largest piece of data an entry yields at a time. */
export const CHUNK = 1024 * 1024

export type EntryKind = "file" | "directory" | "link" | "special"

export type ArchiveEntry = {
  /** The path as stored, decoded as UTF-8 (invalid bytes replaced). Never a safe path: check it. */
  name: string
  kind: EntryKind
  /** The uncompressed size the archive declares. Do not count with it: count the bytes `read` yields. */
  size: number
  encrypted: boolean
  /**
   * The entry's data in pieces of at most `CHUNK` bytes, checked as it is read. Valid while the
   * entries are being iterated; a tar entry can be read once, and only before the next one is asked for.
   */
  read(): AsyncIterable<Uint8Array>
}

/** The archive is damaged, cut short, or uses something this reader refuses to support. */
export class ArchiveUnreadable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ArchiveUnreadable"
  }
}

/** Throws the `AbortError` of an aborted signal. */
export function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

/** `error` itself when it is a cancellation or already `ArchiveUnreadable`; otherwise an `ArchiveUnreadable` saying `message`. */
export function asUnreadable(error: unknown, message: string): Error {
  if (isAbortError(error) || error instanceof ArchiveUnreadable) return error as Error
  return new ArchiveUnreadable(message, { cause: error })
}

/** Opens a regular file without following a link at its path. */
export async function openRegular(path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new ArchiveUnreadable("it is not a regular file")
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
