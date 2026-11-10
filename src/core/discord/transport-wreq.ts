import type { ReadableStreamDefaultReader } from "node:stream/web"
import { fetch } from "wreq-js"
import { BROWSER_PROFILE, type ClientOs } from "./identity"
import { maskTokens } from "./mask"
import { type DownloadTransport, type Transport, TransportFailure } from "./transport"

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
