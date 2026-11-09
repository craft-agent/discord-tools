import type { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import {
  ArchiveUnreadable,
  CHUNK,
  asUnreadable,
  checkAbort,
  openRegular,
  type ArchiveEntry,
  type EntryKind,
} from "./entry"

const BLOCK = 512
const NAME = { at: 0, length: 100 }
const SIZE = { at: 124, length: 12 }
const CHECKSUM = { at: 148, length: 8 }
const TYPE_FLAG = 156
const MAGIC = { at: 257, length: 6 }
const PREFIX = { at: 345, length: 155 }
const USTAR_MAGIC = "ustar\0"
const BASE_256_FLAG = 0x80
const SPACE = 0x20
/** The largest pax or GNU long-name record read: far above any path. */
const METADATA_MAX = 1024 * 1024

const PAX_FILE = "x"
const PAX_GLOBAL = "g"
const GNU_LONG_NAME = "L"
const GNU_LONG_LINK = "K"

const KINDS: Record<string, EntryKind> = {
  "0": "file",
  "\0": "file",
  "7": "file",
  "5": "directory",
  "1": "link",
  "2": "link",
  "3": "special",
  "4": "special",
  "6": "special",
}

type Field = { at: number; length: number }
type Fields = { path?: string; size?: number }

/** Pieces of the bytes a stream yields, taken in exact or at most the sizes asked for. */
class ByteSource {
  private readonly pieces: Buffer[] = []
  private held = 0

  constructor(private readonly input: AsyncIterator<Buffer>) {}

  private async fill(): Promise<boolean> {
    const next = await this.input.next()
    if (next.done) return false
    this.pieces.push(next.value)
    this.held += next.value.length
    return true
  }

  private shift(length: number): Buffer {
    const parts: Buffer[] = []
    for (let need = length; need > 0;) {
      const first = this.pieces[0]
      if (first.length <= need) {
        parts.push(first)
        this.pieces.shift()
        need -= first.length
      } else {
        parts.push(first.subarray(0, need))
        this.pieces[0] = first.subarray(need)
        need = 0
      }
    }
    this.held -= length
    return parts.length === 1 ? parts[0] : Buffer.concat(parts)
  }

  /** Whether the stream has ended with nothing left to take. */
  async ended(): Promise<boolean> {
    while (this.held === 0) if (!(await this.fill())) return true
    return false
  }

  async take(length: number): Promise<Buffer> {
    while (this.held < length) if (!(await this.fill())) throw new ArchiveUnreadable("the archive is cut short")
    return this.shift(length)
  }

  /** Whatever is available, up to `max` bytes. */
  async some(max: number): Promise<Buffer> {
    if (await this.ended()) throw new ArchiveUnreadable("the archive is cut short")
    return this.shift(Math.min(max, this.held))
  }

  async skip(length: number): Promise<void> {
    for (let left = length; left > 0;) left -= (await this.some(left)).length
  }
}

/** The file's bytes, unzipped when asked; closes everything when the consumer stops. */
async function* chunksOf(path: string, gzip: boolean, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const handle = await openRegular(path)
  const file = handle.createReadStream({ autoClose: false, highWaterMark: CHUNK })
  let source: Readable = file
  try {
    if (gzip) {
      source = file.pipe(createGunzip())
      file.on("error", (error) => source.destroy(error))
    }
    for await (const chunk of source) {
      checkAbort(signal)
      yield chunk
    }
  } catch (error) {
    throw asUnreadable(error, "the archive data cannot be read")
  } finally {
    source.destroy()
    file.destroy()
    await handle.close()
  }
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

function text(block: Buffer, field: Field): string {
  const bytes = block.subarray(field.at, field.at + field.length)
  const end = bytes.indexOf(0)
  return bytes.toString("utf8", 0, end < 0 ? bytes.length : end)
}

function octal(block: Buffer, field: Field): number {
  if (block[field.at] & BASE_256_FLAG) throw new ArchiveUnreadable("a tar number in base 256 is not supported")
  const digits = block.toString("latin1", field.at, field.at + field.length).replace(/^ +|[\0 ]+$/g, "")
  if (digits === "") return 0
  if (!/^[0-7]+$/.test(digits)) throw new ArchiveUnreadable("a tar header is damaged")
  return parseInt(digits, 8)
}

function checkSum(block: Buffer): void {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= CHECKSUM.at && i < CHECKSUM.at + CHECKSUM.length ? SPACE : block[i]
  }
  if (sum !== octal(block, CHECKSUM)) throw new ArchiveUnreadable("a tar header does not match its checksum")
}

/** The `path` and `size` records of a pax header. */
function paxFields(body: Buffer): Fields {
  const fields: Fields = {}
  for (let at = 0; at < body.length;) {
    const space = body.indexOf(SPACE, at)
    const digits = space < 0 ? "" : body.toString("latin1", at, space)
    const length = Number(digits)
    if (!/^\d+$/.test(digits) || length <= space - at + 1 || at + length > body.length) {
      throw new ArchiveUnreadable("a tar extended header is damaged")
    }
    const record = body.toString("utf8", space + 1, at + length - 1)
    const equals = record.indexOf("=")
    if (equals < 0) throw new ArchiveUnreadable("a tar extended header is damaged")
    const key = record.slice(0, equals)
    const value = record.slice(equals + 1)
    if (key === "path") fields.path = value
    if (key === "size") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new ArchiveUnreadable("a tar size is damaged")
      fields.size = Number(value)
    }
    at += length
  }
  return fields
}

async function metadata(source: ByteSource, size: number): Promise<Buffer> {
  if (size > METADATA_MAX) throw new ArchiveUnreadable("a tar extended header is too large")
  const body = await source.take(size)
  await source.skip(padding(size))
  return body
}

async function* dataOf(source: ByteSource, state: { remaining: number }, signal?: AbortSignal): AsyncGenerator<Buffer> {
  while (state.remaining > 0) {
    checkAbort(signal)
    const piece = await source.some(Math.min(CHUNK, state.remaining))
    state.remaining -= piece.length
    yield piece
  }
}

/**
 * The entries of a tar file, gzipped or not, read in one pass. An entry's
 * data can be read once, before the next entry is asked for; what is not read
 * is skipped.
 */
export async function* readTar(path: string, gzip: boolean, signal?: AbortSignal): AsyncGenerator<ArchiveEntry> {
  const chunks = chunksOf(path, gzip, signal)
  const source = new ByteSource(chunks)
  try {
    let next: Fields = {}
    let longName: string | undefined
    while (!(await source.ended())) {
      checkAbort(signal)
      const header = await source.take(BLOCK)
      if (header.every((byte) => byte === 0)) return
      checkSum(header)
      const flag = String.fromCharCode(header[TYPE_FLAG])
      const size = octal(header, SIZE)

      if (flag === PAX_FILE) {
        next = paxFields(await metadata(source, size))
      } else if (flag === GNU_LONG_NAME) {
        const body = await metadata(source, size)
        longName = text(body, { at: 0, length: body.length })
      } else if (flag === PAX_GLOBAL || flag === GNU_LONG_LINK) {
        await metadata(source, size)
      } else {
        const prefix =
          header.toString("latin1", MAGIC.at, MAGIC.at + MAGIC.length) === USTAR_MAGIC ? text(header, PREFIX) : ""
        const stored = prefix ? `${prefix}/${text(header, NAME)}` : text(header, NAME)
        const name = next.path ?? longName ?? stored
        const kind = KINDS[flag] ?? "special"
        const hasData = kind === "file" || !Object.hasOwn(KINDS, flag)
        const dataSize = hasData ? (next.size ?? size) : 0
        const state = { remaining: dataSize, used: false }
        next = {}
        longName = undefined

        yield {
          name,
          kind: kind === "file" && name.endsWith("/") ? "directory" : kind,
          size: dataSize,
          encrypted: false,
          read() {
            if (state.used) throw new Error("A tar entry can be read once")
            state.used = true
            return dataOf(source, state, signal)
          },
        }
        const unread = state.remaining
        state.remaining = 0
        state.used = true
        await source.skip(unread + padding(dataSize))
      }
    }
  } finally {
    await chunks.return(undefined)
  }
}
