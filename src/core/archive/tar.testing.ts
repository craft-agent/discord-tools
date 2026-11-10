import { gzipSync } from "node:zlib"

const BLOCK = 512

export type TarItem = {
  name: string
  data?: string | Uint8Array
  /** The type flag; the default is "0", a regular file. */
  type?: string
  link?: string
  /** Pax records for this entry (`path`, `size`, …). The header then carries a placeholder name. */
  pax?: Record<string, string>
  /** Writes the name as a GNU long-name record and cuts it in the header. */
  longName?: boolean
  /** Written in the ustar prefix field. */
  prefix?: string
}

function ascii(block: Buffer, at: number, text: string): void {
  block.write(text, at, "latin1")
}

function tarHeader(name: string, size: number, type: string, item: Partial<TarItem> = {}): Buffer {
  const block = Buffer.alloc(BLOCK)
  block.write(name.slice(0, 100), 0)
  ascii(block, 100, "0000644\0")
  ascii(block, 108, "0000000\0")
  ascii(block, 116, "0000000\0")
  ascii(block, 124, `${size.toString(8).padStart(11, "0")}\0`)
  ascii(block, 136, "00000000000\0")
  ascii(block, 148, "        ")
  ascii(block, 156, type)
  block.write(item.link ?? "", 157)
  ascii(block, 257, "ustar\0")
  ascii(block, 263, "00")
  block.write(item.prefix ?? "", 345)
  const sum = block.reduce((total, byte) => total + byte, 0)
  ascii(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `)
  return block
}

function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)])
}

function paxBody(records: Record<string, string>): Buffer {
  const lines = Object.entries(records).map(([key, value]) => {
    const rest = ` ${key}=${value}\n`
    let length = Buffer.byteLength(rest) + 1
    while (String(length).length + Buffer.byteLength(rest) !== length)
      length = String(length).length + Buffer.byteLength(rest)
    return `${length}${rest}`
  })
  return Buffer.from(lines.join(""))
}

/** A tar file in the ustar format with the optional pax and GNU extensions, ended by two zero blocks. */
export function tarBytes(items: TarItem[]): Buffer {
  const blocks: Buffer[] = []
  for (const item of items) {
    const body = Buffer.from(item.data ?? "")
    const type = item.type ?? "0"
    if (item.pax) {
      const records = paxBody(item.pax)
      blocks.push(tarHeader("PaxHeader/entry", records.length, "x"), padded(records))
    }
    if (item.longName) {
      const long = Buffer.from(`${item.name}\0`)
      blocks.push(tarHeader("././@LongLink", long.length, "L"), padded(long))
    }
    blocks.push(tarHeader(item.pax?.path ? "placeholder" : item.name, body.length, type, item), padded(body))
  }
  return Buffer.concat([...blocks, Buffer.alloc(2 * BLOCK)])
}

/** The same tar, gzipped. */
export function tarGzBytes(items: TarItem[]): Buffer {
  return gzipSync(tarBytes(items))
}
