import { crc32, deflateRawSync } from "node:zlib"

const UNIX_VERSION = (3 << 8) | 20
const DOS_DATE = 0x21
const MODE_REGULAR = 0o100644
const MODE_DIRECTORY = 0o040755
const MODE_LINK = 0o120777
const MODE_FIFO = 0o010644

/** The mode a zip entry of each kind carries in the high half of its external attributes. */
export const ZIP_EXTERNAL = {
  regular: (MODE_REGULAR << 16) >>> 0,
  directory: (MODE_DIRECTORY << 16) >>> 0,
  link: (MODE_LINK << 16) >>> 0,
  fifo: (MODE_FIFO << 16) >>> 0,
}

export type ZipItem = {
  name: string
  data?: string | Uint8Array
  /** Deflate the data (the default is to store it). */
  deflate?: boolean
  /** The external attributes; the default is 0, as an archiver that stores no file type writes it. */
  external?: number
  encrypted?: boolean
  /** The uncompressed size the headers claim, whatever the data is. */
  declared?: number
  /** The CRC-32 the headers claim, whatever the data is. */
  crc?: number
  /** The compression method the headers claim. */
  method?: number
}

function fields(...parts: Array<[width: 2 | 4, value: number]>): Buffer {
  const out = Buffer.alloc(parts.reduce((sum, [width]) => sum + width, 0))
  let at = 0
  for (const [width, value] of parts) {
    if (width === 2) out.writeUInt16LE(value, at)
    else out.writeUInt32LE(value, at)
    at += width
  }
  return out
}

/** A zip file: local headers and data, the central directory, the end record. */
export function zipBytes(items: ZipItem[]): Buffer {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const item of items) {
    const raw = Buffer.from(item.data ?? "")
    const stored = item.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(item.name)
    const method = item.method ?? (item.deflate ? 8 : 0)
    const flags = item.encrypted ? 1 : 0
    const crc = item.crc ?? crc32(raw)
    const sizes: Array<[2 | 4, number]> = [
      [4, crc],
      [4, stored.length],
      [4, item.declared ?? raw.length],
      [2, name.length],
      [2, 0],
    ]
    const local = Buffer.concat([
      fields([4, 0x04034b50], [2, 20], [2, flags], [2, method], [2, 0], [2, DOS_DATE], ...sizes),
      name,
      stored,
    ])
    directory.push(
      Buffer.concat([
        fields(
          [4, 0x02014b50],
          [2, UNIX_VERSION],
          [2, 20],
          [2, flags],
          [2, method],
          [2, 0],
          [2, DOS_DATE],
          ...sizes,
          [2, 0],
          [2, 0],
          [2, 0],
          [4, item.external ?? 0],
          [4, offset],
        ),
        name,
      ]),
    )
    locals.push(local)
    offset += local.length
  }
  const central = Buffer.concat(directory)
  const end = fields(
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, items.length],
    [2, items.length],
    [4, central.length],
    [4, offset],
    [2, 0],
  )
  return Buffer.concat([...locals, central, end])
}
