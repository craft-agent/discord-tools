import { Buffer } from "node:buffer"
import { constants, createInflate } from "node:zlib"

/** The four bytes a sync flush leaves at the end of every complete `zlib-stream` payload. */
const PAYLOAD_END = Buffer.from([0x00, 0x00, 0xff, 0xff])

/** How much a connection may send, packed and unpacked, before it is given up on. */
export type InflateLimits = { maxPackedBytes: number; maxUnpackedBytes: number }

/** Unpacks the payloads of one `zlib-stream` connection, which share a single zlib context. */
export type GatewayInflater = {
  /**
   * Takes the next frame. A payload may span several frames and ends where one
   * ends with the sync-flush marker: the text comes back then, and `undefined`
   * while more is awaited. Rejects when the data is not zlib or past the limits.
   */
  push(frame: Uint8Array): Promise<string | undefined>
  /** Frees the zlib context; `push` is not used afterwards. */
  end(): void
}

/** Starts the zlib context of a connection. */
export function createGatewayInflater(limits: InflateLimits): GatewayInflater {
  const inflate = createInflate({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH })
  let frames: Buffer[] = []
  let packedBytes = 0
  let tail = Buffer.alloc(0)
  let unpacked: Buffer[] = []
  let unpackedBytes = 0
  let failure: Error | undefined

  inflate.on("data", (chunk: Buffer) => {
    unpackedBytes += chunk.length
    if (unpackedBytes > limits.maxUnpackedBytes) {
      failure ??= new Error("The payload is larger than allowed.")
      inflate.destroy()
      return
    }
    unpacked.push(chunk)
  })
  inflate.on("error", (error) => {
    failure ??= error
  })

  const unpack = (payload: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onClose = () => resolve()
      inflate.once("close", onClose)
      inflate.write(payload, (error) => {
        inflate.off("close", onClose)
        if (error) reject(error)
        else resolve()
      })
    })

  return {
    async push(frame) {
      frames.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))
      packedBytes += frame.byteLength
      if (packedBytes > limits.maxPackedBytes) throw new Error("The payload is larger than allowed.")
      tail = Buffer.concat([tail, frames.at(-1)!.subarray(-PAYLOAD_END.length)]).subarray(-PAYLOAD_END.length)
      if (!tail.equals(PAYLOAD_END)) return undefined

      const payload = Buffer.concat(frames)
      frames = []
      packedBytes = 0
      tail = Buffer.alloc(0)
      unpacked = []
      unpackedBytes = 0
      await unpack(payload)
      if (failure) throw failure
      return Buffer.concat(unpacked).toString("utf8")
    },
    end() {
      inflate.destroy()
    },
  }
}
