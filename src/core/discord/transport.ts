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
