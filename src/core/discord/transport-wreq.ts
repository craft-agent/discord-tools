import { fetch } from "wreq-js"
import { BROWSER_PROFILE, type ClientOs } from "./identity"
import { maskTokens } from "./mask"
import { type Transport, TransportFailure } from "./transport"

/**
 * wreq reports a failure as one `RequestError` whose text is the native
 * layer's. A failure while connecting (DNS, TCP, TLS handshake) reads
 * `client error (Connect)` and happens before any request byte is sent; a
 * time-out, a reset after connecting, a bad answer and everything else is
 * treated as possibly sent.
 */
const BEFORE_SENDING = /client error \(Connect\)/

const MAX_DETAIL_LENGTH = 200

function failure(error: unknown): TransportFailure {
  const text = error instanceof Error ? error.message : String(error)
  const detail = maskTokens(text).slice(0, MAX_DETAIL_LENGTH)
  if (error instanceof Error && error.name === "AbortError") {
    return new TransportFailure("The request was cancelled after it was sent.", true)
  }
  return new TransportFailure(`Network error: ${detail}`, !BEFORE_SENDING.test(text))
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
      const headers: Record<string, string> = {}
      for (const [name, value] of response.headers) {
        const key = name.toLowerCase()
        headers[key] = Object.hasOwn(headers, key) ? `${headers[key]}, ${value}` : value
      }
      return { status: response.status, headers, body: await response.text() }
    } catch (error) {
      throw failure(error)
    }
  }
}
