/** One HTTP request, with its headers in the order they are sent. */
export type TransportRequest = {
  method: string
  url: string
  /** Sent as given and in order, unless `navigation` is set. */
  headers: [string, string][]
  /** A page load: the transport adds the browser's own navigation headers, and `headers` only override them. */
  navigation?: true
  body?: string | Uint8Array
  timeoutMs: number
  signal?: AbortSignal
}

/** An HTTP answer; header names are lower-case and the body is text. */
export type TransportResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

/** Sends one request as it is: no retries, no redirects followed. Rejects with a `TransportFailure` below HTTP. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

/** An HTTP answer whose body is still being received. */
export type DownloadResponse = {
  status: number
  /** Names are lower-case. */
  headers: Record<string, string>
  /** The decoded body, chunk by chunk. Rejects with a `TransportFailure` when the request fails, is cancelled or times out while it is read. */
  body: AsyncIterable<Uint8Array>
  /** Gives up on the rest of the body and frees the connection; safe to call after the body ended or more than once. */
  cancel(): Promise<void>
}

/** Like `Transport`, but resolves at the headers and leaves the body to be read. Same `TransportFailure` semantics. */
export type DownloadTransport = (request: TransportRequest) => Promise<DownloadResponse>

/** What happened on a WebSocket. */
export type SocketEvent =
  | { type: "message"; data: Uint8Array | string }
  /** The connection ended: the peer closed it, we did, or it failed (code 1006, with `error` the failure's text when known). */
  | { type: "close"; code: number; reason: string; error?: string }

/** A WebSocket to open: the upgrade request's URL and headers (in order), and the largest message accepted. */
export type SocketRequest = Pick<TransportRequest, "url" | "headers" | "signal"> & { maxMessageSize: number }

/** An open WebSocket, read by pulling events one after another so that none is missed. */
export type TransportSocket = {
  /** The next event, in order; once the connection has ended, `close` again. Ask for one at a time. */
  next(): Promise<SocketEvent>
  /** Sends a text frame. */
  send(text: string): void
  /** Starts closing with `code` and resolves once the connection has ended; safe to call again. */
  close(code: number): Promise<void>
}

/** Opens a WebSocket without waiting for the connection: events, a failure to connect included, arrive through `next`. Rejects with a `TransportFailure` for a request it cannot make. */
export type SocketTransport = (request: SocketRequest) => Promise<TransportSocket>

/** A request that failed below HTTP. */
export class TransportFailure extends Error {
  /** False only when the request cannot have left the machine (no connection was made, or it was cancelled before sending). */
  readonly dispatched: boolean

  constructor(message: string, dispatched: boolean) {
    super(message)
    this.name = "TransportFailure"
    this.dispatched = dispatched
  }
}
