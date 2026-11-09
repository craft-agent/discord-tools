import { Buffer } from "node:buffer"
import { type DownloadResponse, type DownloadTransport, type TransportRequest, TransportFailure } from "./transport"

/** What the fake media host answers. */
export type MediaAnswer = {
  status?: number
  headers?: Record<string, string>
  /** The body, one chunk each. */
  chunks?: (string | Uint8Array)[]
  /** What happens after the last chunk: the body ends (default), fails with this text, or hangs until the request is cancelled. */
  after?: "end" | "hang" | { fail: string }
}

/** A request the fake received, with the headers in the order they were sent. */
export type MediaRequest = {
  url: string
  method: string
  headers: [string, string][]
  timeoutMs: number
  /** The fake clock when it arrived. */
  at: number
}

/** An in-process media host: a `DownloadTransport` that records what it receives. */
function resolvers(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export class FakeMedia {
  answer: MediaAnswer | ((request: MediaRequest) => MediaAnswer) = { chunks: [] }
  readonly requests: MediaRequest[] = []
  /** The chunks handed out so far. */
  chunksRead = 0
  /** How many bodies were cancelled. */
  cancelled = 0
  /** Settles when a body reached its `hang`. */
  readonly hanging: { promise: Promise<void>; resolve: () => void } = resolvers()
  readonly #now: () => number
  #failure: TransportFailure | undefined

  constructor(now: () => number = () => 0) {
    this.#now = now
  }

  /** Makes the next request fail below HTTP. */
  failNext(message: string, dispatched = true): this {
    this.#failure = new TransportFailure(message, dispatched)
    return this
  }

  readonly transport: DownloadTransport = async (request) => {
    const recorded: MediaRequest = {
      url: request.url,
      method: request.method,
      headers: request.headers.map(([name, value]) => [name, value]),
      timeoutMs: request.timeoutMs,
      at: this.#now(),
    }
    this.requests.push(recorded)
    if (this.#failure) {
      const failure = this.#failure
      this.#failure = undefined
      throw failure
    }
    const answer = typeof this.answer === "function" ? this.answer(recorded) : this.answer
    return this.#response(answer, request)
  }

  #response(answer: MediaAnswer, request: TransportRequest): DownloadResponse {
    const after = answer.after ?? "end"
    const chunks = (answer.chunks ?? []).map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk))
    const fake = this
    return {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
      body: (async function* () {
        for (const chunk of chunks) {
          fake.chunksRead += 1
          yield chunk
        }
        if (after === "end") return
        if (after !== "hang") throw new TransportFailure(after.fail, true)
        fake.hanging.resolve()
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve()
          request.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        throw new TransportFailure("The request was cancelled after it was sent.", true)
      })(),
      cancel: async () => {
        fake.cancelled += 1
      },
    }
  }
}
