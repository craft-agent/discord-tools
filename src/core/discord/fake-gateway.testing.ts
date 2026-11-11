import { Buffer } from "node:buffer"
import { constants, createDeflate } from "node:zlib"
import type { SocketEvent, SocketRequest, SocketTransport, TransportSocket } from "./transport"

/** Gateway opcodes the fake speaks. */
export const OP_DISPATCH = 0
export const OP_IDENTIFY = 2
export const OP_INVALID_SESSION = 9
export const OP_HELLO = 10

/** What the fake's READY holds unless a test says otherwise. */
export const FAKE_USER_ID = "123456789012345678"

/** The `d` of a READY dispatch. */
export function readyData(
  entries: unknown[] = [],
  options: { partial?: boolean; userId?: string } = {},
): Record<string, unknown> {
  return {
    user: { id: options.userId ?? FAKE_USER_ID, username: "someone" },
    read_state: { entries, partial: options.partial ?? false, version: 7 },
    guilds: [],
  }
}

/** Compresses the way Discord's `zlib-stream` does: one context for the connection, every payload sync-flushed. */
export class ZlibEncoder {
  readonly #deflate = createDeflate()
  #chunks: Buffer[] = []

  constructor() {
    this.#deflate.on("data", (chunk: Buffer) => this.#chunks.push(chunk))
  }

  async encode(text: string): Promise<Buffer> {
    this.#chunks = []
    this.#deflate.write(text)
    await new Promise<void>((resolve) => this.#deflate.flush(constants.Z_SYNC_FLUSH, () => resolve()))
    return Buffer.concat(this.#chunks)
  }

  end(): void {
    this.#deflate.destroy()
  }
}

/** What a script can make the server side of one connection do. */
export type FakeGatewayControl = {
  /** The upgrade request, as the client made it. */
  request: SocketRequest
  /** Everything the client has sent on this connection, parsed. */
  sent: unknown[]
  /** Sends `{ op, d, t }` compressed, split over `frames` frames. */
  payload(payload: { op: number; d?: unknown; t?: string }, frames?: number): Promise<void>
  hello(heartbeatInterval?: number): Promise<void>
  ready(data?: unknown): Promise<void>
  /** Sends bytes as they are, as one frame. */
  raw(data: Uint8Array | string): void
  /** Closes the connection from the server. */
  close(code: number, reason?: string, error?: string): void
}

/** One connection of the fake gateway, from the client's side. */
class FakeSocket implements TransportSocket {
  readonly sentText: string[] = []
  readonly closes: number[] = []
  #queue: SocketEvent[] = []
  #ended: SocketEvent | undefined
  #waiting: ((event: SocketEvent) => void) | undefined

  push(event: SocketEvent): void {
    if (this.#ended) return
    if (event.type === "close") this.#ended = event
    const waiting = this.#waiting
    this.#waiting = undefined
    if (waiting) waiting(event)
    else this.#queue.push(event)
  }

  next(): Promise<SocketEvent> {
    const event = this.#queue.shift() ?? this.#ended
    return event ? Promise.resolve(event) : new Promise((resolve) => (this.#waiting = resolve))
  }

  onSend: (text: string) => void = () => {}

  send(text: string): void {
    if (this.#ended) throw new Error("WebSocket is not open")
    this.sentText.push(text)
    this.onSend(text)
  }

  close(code: number): Promise<void> {
    this.closes.push(code)
    this.push({ type: "close", code, reason: "" })
    return Promise.resolve()
  }

  get isClosed(): boolean {
    return this.#ended !== undefined
  }
}

/**
 * An in-process Discord gateway: a `SocketTransport` that records each
 * connection and plays a script on it. By default the server says Hello on
 * connecting and answers Identify with READY.
 */
export class FakeGateway {
  /** The READY data sent by the default script. */
  readyData: unknown = readyData()
  readonly requests: SocketRequest[] = []
  readonly sockets: FakeSocket[] = []
  /** Runs when a connection opens; the default says Hello. */
  onOpen: (control: FakeGatewayControl) => void | Promise<void> = (control) => control.hello()
  /** Runs for each frame the client sends; the default answers Identify with READY. */
  onSend: (frame: unknown, control: FakeGatewayControl) => void | Promise<void> = (frame, control) => {
    if (isOp(frame, OP_IDENTIFY)) return control.ready()
  }
  /** Makes opening fail below the WebSocket, as a request that cannot be made. */
  failOpen: Error | undefined

  /** Every frame the client sent, over all connections, parsed. */
  get sent(): unknown[] {
    return this.sockets.flatMap((socket) => socket.sentText.map((text) => JSON.parse(text) as unknown))
  }

  /** The codes the client closed with, over all connections. */
  get closes(): number[] {
    return this.sockets.flatMap((socket) => socket.closes)
  }

  readonly transport: SocketTransport = async (request) => {
    this.requests.push(request)
    if (this.failOpen) throw this.failOpen
    const socket = new FakeSocket()
    const encoder = new ZlibEncoder()
    const sent: unknown[] = []
    const control: FakeGatewayControl = {
      request,
      sent,
      payload: async (payload, frames = 1) => {
        const bytes = await encoder.encode(JSON.stringify(payload))
        const size = Math.ceil(bytes.length / frames)
        for (let start = 0; start < bytes.length; start += size)
          socket.push(frameOf(bytes.subarray(start, start + size)))
      },
      hello: (interval = 41_250) => control.payload({ op: OP_HELLO, d: { heartbeat_interval: interval } }),
      ready: (data = this.readyData) => control.payload({ op: OP_DISPATCH, t: "READY", d: data }),
      raw: (data) => socket.push({ type: "message", data }),
      close: (code, reason = "", error) => socket.push({ type: "close", code, reason, ...(error ? { error } : {}) }),
    }
    socket.onSend = (text) => {
      const frame = JSON.parse(text) as unknown
      sent.push(frame)
      void this.onSend(frame, control)
    }
    this.sockets.push(socket)
    void this.onOpen(control)
    return socket
  }
}

function frameOf(data: Uint8Array): SocketEvent {
  return { type: "message", data }
}

/** Whether a parsed frame has the opcode. */
export function isOp(frame: unknown, op: number): boolean {
  return typeof frame === "object" && frame !== null && (frame as { op?: unknown }).op === op
}
