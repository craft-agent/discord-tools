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
