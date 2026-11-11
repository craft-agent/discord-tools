import type { ReadableStreamDefaultReader } from "node:stream/web"
import { WebSocket, fetch } from "wreq-js"
import { BROWSER_PROFILE, type ClientOs } from "./identity"
import { maskTokens } from "./mask"
import {
  type DownloadTransport,
  type SocketEvent,
  type SocketTransport,
  type Transport,
  TransportFailure,
} from "./transport"

/**
 * wreq reports a failure as one `RequestError` whose text is the native
 * layer's. A failure while connecting (DNS, TCP, TLS handshake) reads
 * `client error (Connect)` and happens before any request byte is sent; a
 * time-out, a reset after connecting, a bad answer and everything else is
 * treated as possibly sent.
 */
const BEFORE_SENDING = /client error \(Connect\)/

const MAX_DETAIL_LENGTH = 200

type BodyReader = ReadableStreamDefaultReader<Uint8Array>

function failure(error: unknown): TransportFailure {
  const text = error instanceof Error ? error.message : String(error)
  const detail = maskTokens(text).slice(0, MAX_DETAIL_LENGTH)
  if (error instanceof Error && error.name === "AbortError") {
    return new TransportFailure("The request was cancelled after it was sent.", true)
  }
  return new TransportFailure(`Network error: ${detail}`, !BEFORE_SENDING.test(text))
}

function lowerCaseHeaders(source: Iterable<[string, string]>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of source) {
    const key = name.toLowerCase()
    headers[key] = Object.hasOwn(headers, key) ? `${headers[key]}, ${value}` : value
  }
  return headers
}

/**
 * The body of a response as chunks, whose failures are `TransportFailure`s; a
 * response without a body has none. wreq ends a body being read at its time
 * limit but not on the signal, so an abort cancels the reader itself.
 */
async function* chunksOf(reader: BodyReader | undefined, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  if (!reader) return
  const cancel = () => void reader.cancel().catch(() => {})
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new TransportFailure("The request was cancelled after it was sent.", true)
      if (done) return
      yield value
    }
  } catch (error) {
    throw error instanceof TransportFailure ? error : failure(error)
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

/**
 * A transport that presents Chrome's TLS and HTTP/2 fingerprint through wreq.
 * The headers are sent exactly as given and in order (a navigation request
 * gets the profile's own headers, which the given ones override), redirects are returned
 * rather than followed, and compressed bodies are decoded.
 */
export function wreqTransport(os: ClientOs): Transport {
  return async (request) => {
    if (request.signal?.aborted) throw new TransportFailure("The request was cancelled before it was sent.", false)
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        browser: BROWSER_PROFILE,
        os,
        ...(request.navigation ? {} : { disableDefaultHeaders: true }),
        redirect: "manual",
        timeout: request.timeoutMs,
        signal: request.signal,
      })
      return { status: response.status, headers: lowerCaseHeaders(response.headers), body: await response.text() }
    } catch (error) {
      throw failure(error)
    }
  }
}

/**
 * A transport that opens a WebSocket with Chrome's TLS fingerprint through
 * wreq. The socket is made with the constructor, not `websocket()`, so its
 * listeners are in place before the connection completes: `websocket()` hands
 * the socket back only afterwards, and a message that arrived by then, such as
 * Discord's first, would reach nobody. Events are queued until `next` takes
 * them. wreq keeps no time limit for connecting, and a close while connecting
 * ends only once the connection settles, so the caller bounds its waiting.
 */
export function wreqSocket(os: ClientOs): SocketTransport {
  return async (request) => {
    if (request.signal?.aborted) throw new TransportFailure("The request was cancelled before it was sent.", false)
    const queued: SocketEvent[] = []
    let ended: SocketEvent | undefined
    let waiting: ((event: SocketEvent) => void) | undefined
    let lastError: string | undefined
    let closed: () => void = () => {}
    const closedPromise = new Promise<void>((resolve) => (closed = resolve))

    const push = (event: SocketEvent): void => {
      if (ended) return
      if (event.type === "close") ended = event
      const taker = waiting
      waiting = undefined
      if (taker) taker(event)
      else queued.push(event)
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(request.url, {
        browser: BROWSER_PROFILE,
        os,
        headers: request.headers,
        maxMessageSize: request.maxMessageSize,
        maxFrameSize: request.maxMessageSize,
      })
    } catch (error) {
      throw failure(error)
    }
    socket.addEventListener("message", ({ data }) => {
      if (typeof data === "string" || data instanceof Uint8Array) push({ type: "message", data })
    })
    socket.addEventListener("error", ({ message }) => {
      lastError = message === undefined ? undefined : maskTokens(message).slice(0, MAX_DETAIL_LENGTH)
    })
    socket.addEventListener("close", ({ code, reason }) => {
      push({ type: "close", code, reason, ...(lastError === undefined ? {} : { error: lastError }) })
      closed()
    })

    return {
      next: () => {
        const event = queued.shift() ?? ended
        return event ? Promise.resolve(event) : new Promise((resolve) => (waiting = resolve))
      },
      send: (text) => socket.send(text),
      close: (code) => {
        socket.close(code)
        return closedPromise
      },
    }
  }
}

/**
 * Like `wreqTransport` for a file: the answer resolves at the headers and the
 * body is read chunk by chunk, so it never has to fit in memory. The headers
 * are sent exactly as given, redirects are returned rather than followed, and
 * the time limit and the signal also end a body being read.
 */
export function wreqDownload(os: ClientOs): DownloadTransport {
  return async (request) => {
    if (request.signal?.aborted) throw new TransportFailure("The request was cancelled before it was sent.", false)
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        browser: BROWSER_PROFILE,
        os,
        disableDefaultHeaders: true,
        redirect: "manual",
        timeout: request.timeoutMs,
        signal: request.signal,
      })
      const reader = response.body?.getReader()
      return {
        status: response.status,
        headers: lowerCaseHeaders(response.headers),
        body: chunksOf(reader, request.signal),
        cancel: async () => {
          await reader?.cancel().catch(() => {})
        },
      }
    } catch (error) {
      throw failure(error)
    }
  }
}
