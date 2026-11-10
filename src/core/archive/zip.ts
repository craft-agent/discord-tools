import type { FileHandle } from "node:fs/promises"
import { Readable } from "node:stream"
import { createInflateRaw, crc32 } from "node:zlib"
import {
  ArchiveUnreadable,
  CHUNK,
  asUnreadable,
  checkAbort,
  openRegular,
  type ArchiveEntry,
  type EntryKind,
} from "./entry"

const END_SIGNATURE = 0x06054b50
const DIRECTORY_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const END_SIZE = 22
const DIRECTORY_RECORD_SIZE = 46
const LOCAL_HEADER_SIZE = 30
/** The end record is at most this far from the end of the file: its size plus the longest comment. */
const END_SEARCH = END_SIZE + 0xffff
/** The largest central directory read: far above what the 65534 entries a zip without zip64 can have need. */
const DIRECTORY_MAX = 32 * 1024 * 1024
const MARKER_16 = 0xffff
const MARKER_32 = 0xffffffff
const STORED = 0
const DEFLATED = 8
const ENCRYPTED_FLAG = 0x1

const MODE_TYPE = 0o170000
const MODE_REGULAR = 0o100000
const MODE_DIRECTORY = 0o040000
const MODE_LINK = 0o120000

type ZipRecord = {
  name: string
  kind: EntryKind
  encrypted: boolean
  method: number
  crc: number
  compressed: number
  uncompressed: number
  offset: number
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  for (let done = 0; done < length;) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
    if (bytesRead === 0) throw new ArchiveUnreadable("the archive is cut short")
    done += bytesRead
  }
  return buffer
}

function kindOf(name: string, external: number): EntryKind {
  const mode = (external >>> 16) & MODE_TYPE
  if (mode === MODE_LINK) return "link"
  if (mode !== 0 && mode !== MODE_REGULAR && mode !== MODE_DIRECTORY) return "special"
  return mode === MODE_DIRECTORY || name.endsWith("/") ? "directory" : "file"
}

/** The records of the central directory, and where the entries' data must end (where the directory starts). */
async function readDirectory(handle: FileHandle, size: number): Promise<{ records: ZipRecord[]; dataEnd: number }> {
  const length = Math.min(size, END_SEARCH)
  const tail = await readAt(handle, size - length, length)
  let end = length - END_SIZE
  while (
    end >= 0 &&
    !(tail.readUInt32LE(end) === END_SIGNATURE && end + END_SIZE + tail.readUInt16LE(end + 20) <= length)
  ) {
    end -= 1
  }
  if (end < 0) throw new ArchiveUnreadable("no zip directory found")

  const count = tail.readUInt16LE(end + 10)
  const directorySize = tail.readUInt32LE(end + 12)
  const directoryOffset = tail.readUInt32LE(end + 16)
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) {
    throw new ArchiveUnreadable("a zip in several parts is not supported")
  }
  if (count === MARKER_16 || directorySize === MARKER_32 || directoryOffset === MARKER_32) {
    throw new ArchiveUnreadable("zip64 is not supported")
  }
  if (directorySize > DIRECTORY_MAX || directoryOffset + directorySize > size - length + end) {
    throw new ArchiveUnreadable("the zip directory is out of place")
  }

  const directory = await readAt(handle, directoryOffset, directorySize)
  const records: ZipRecord[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (at + DIRECTORY_RECORD_SIZE > directory.length || directory.readUInt32LE(at) !== DIRECTORY_SIGNATURE) {
      throw new ArchiveUnreadable("the zip directory is damaged")
    }
    const nameLength = directory.readUInt16LE(at + 28)
    const next =
      at + DIRECTORY_RECORD_SIZE + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32)
    const compressed = directory.readUInt32LE(at + 20)
    const uncompressed = directory.readUInt32LE(at + 24)
    const offset = directory.readUInt32LE(at + 42)
    if (next > directory.length) throw new ArchiveUnreadable("the zip directory is damaged")
    if (compressed === MARKER_32 || uncompressed === MARKER_32 || offset === MARKER_32) {
      throw new ArchiveUnreadable("zip64 is not supported")
    }
    if (directory.readUInt16LE(at + 34) !== 0) throw new ArchiveUnreadable("a zip in several parts is not supported")
    const name = directory.toString("utf8", at + DIRECTORY_RECORD_SIZE, at + DIRECTORY_RECORD_SIZE + nameLength)
    records.push({
      name,
      kind: kindOf(name, directory.readUInt32LE(at + 38)),
      encrypted: (directory.readUInt16LE(at + 8) & ENCRYPTED_FLAG) !== 0,
      method: directory.readUInt16LE(at + 10),
      crc: directory.readUInt32LE(at + 16),
      compressed,
      uncompressed,
      offset,
    })
    at = next
  }
  return { records, dataEnd: directoryOffset }
}

async function* range(handle: FileHandle, start: number, length: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (let done = 0; done < length;) {
    checkAbort(signal)
    const piece = await readAt(handle, start + done, Math.min(CHUNK, length - done))
    done += piece.length
    yield piece
  }
}

async function* inflated(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const input = Readable.from(source, { objectMode: false })
  const inflate = createInflateRaw()
  input.on("error", (error) => inflate.destroy(error))
  input.pipe(inflate)
  try {
    yield* inflate
  } catch (error) {
    throw asUnreadable(error, "the data of an entry does not inflate")
  } finally {
    input.destroy()
    inflate.destroy()
  }
}

async function* dataOf(
  handle: FileHandle,
  record: ZipRecord,
  dataEnd: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  if (record.encrypted) throw new ArchiveUnreadable("an encrypted entry cannot be read")
  if (record.method !== STORED && record.method !== DEFLATED) {
    throw new ArchiveUnreadable(`compression method ${record.method} is not supported`)
  }
  const local = await readAt(handle, record.offset, LOCAL_HEADER_SIZE)
  if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ArchiveUnreadable("a zip entry header is damaged")
  const start = record.offset + LOCAL_HEADER_SIZE + local.readUInt16LE(26) + local.readUInt16LE(28)
  if (start + record.compressed > dataEnd) throw new ArchiveUnreadable("the data of a zip entry is out of place")

  const stored = range(handle, start, record.compressed, signal)
  let crc = 0
  for await (const piece of record.method === STORED ? stored : inflated(stored)) {
    crc = crc32(piece, crc)
    yield piece
  }
  if (crc !== record.crc) throw new ArchiveUnreadable("the checksum of a zip entry does not match")
}

/** The entries of a zip file, from its central directory. Data is read on demand and checked against its CRC-32. */
export async function* readZip(path: string, signal?: AbortSignal): AsyncGenerator<ArchiveEntry> {
  const handle = await openRegular(path)
  try {
    const { size } = await handle.stat()
    const { records, dataEnd } = await readDirectory(handle, size)
    for (const record of records) {
      checkAbort(signal)
      yield {
        name: record.name,
        kind: record.kind,
        size: record.uncompressed,
        encrypted: record.encrypted,
        read: () => dataOf(handle, record, dataEnd, signal),
      }
    }
  } finally {
    await handle.close()
  }
}
