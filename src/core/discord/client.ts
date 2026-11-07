import { ToolError } from "../errors"
import { abortError } from "../exec"
import { buildNumber } from "./build-number"
import { httpError, parseJson, requiresTwoFactor, retryAfter } from "./http-errors"
import {
  type ClientHints,
  type ClientOs,
  clientHints,
  clientOs,
  discordLocale,
  loadLaunch,
  locale,
  superProperties,
  timeZone,
} from "./identity"
import type { LabelPaths } from "./labels"
import { maskTokens } from "./mask"
import { createPacer } from "./pacing"
import { DEFAULT_REFERER, REQUEST_HEADER_ORDER, requestHeaders } from "./request-headers"
import { readToken, recordRejected, rejectedAt } from "./token"
import { type Transport, type TransportRequest, type TransportResponse, TransportFailure } from "./transport"

export { REQUEST_HEADER_ORDER }

/** Where every API request goes. */
export const API_BASE = "https://discord.com/api/v9"

/** Time limits of one request. */
export const READ_TIMEOUT_MS = 20_000
export const WRITE_TIMEOUT_MS = 30_000

/** The longest rate limit, in seconds, a read waits out, once. */
export const MAX_RATE_LIMIT_WAIT_S = 30

/** Added to a wait, in seconds, so retries do not land on the dot. */
const RETRY_JITTER_MIN_S = 0.2
const RETRY_JITTER_SPAN_S = 0.6

/** The code of a 202 that says a search index is still being built, and how long to wait without a hint. */
const INDEXING_CODE = 110_000
const INDEXING_WAIT_S = 5

/** Longest path preview in an invalid-argument error. */
const MAX_PATH_PREVIEW_LENGTH = 80

/** Longest message from an underlying network error included in a failure. */
const MAX_ERROR_DETAIL_LENGTH = 200

/** Milliseconds in one second. */
const MS_PER_SECOND = 1000

type RequestKind = "read" | "write"

/** Thrown, before anything is sent, when the request budget is spent. Not a `ToolError`: it is the caller's own limit. */
export class BudgetSpent extends Error {
  constructor() {
    super("The request budget is spent; the rest continues next run.")
    this.name = "BudgetSpent"
  }
}

/** Per-call options of a request. */
export type RequestOptions = {
  query?: Record<string, string | number | undefined>
  /** Sent as JSON. */
  body?: unknown
  /** The web page the request claims to come from; a path. */
  referer?: string
  /** Sent as `X-Audit-Log-Reason`. */
  reason?: string
  signal?: AbortSignal
}

export type DiscordClientOptions = {
  /** The state root, where the build number is cached. */
  stateDir: string
  paths: LabelPaths
  tokenVariable: string
  env: Record<string, string | undefined>
  /** Sends the requests; by default Chrome's fingerprint through wreq, loaded on first use. */
  transport?: Transport
  /** Internal: overrides loading the native transport on first use. */
  loadTransport?: (os: ClientOs) => Promise<Transport>
  os?: ClientOs
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** The most requests this client sends; one more throws `BudgetSpent`. */
  budget?: number
}

/** The one way to reach Discord's API as the label's account. */
export type DiscordClient = {
  /** A read: paced, a short rate limit or a search index still being built is waited out once. Never `uncertain`. */
  read<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  /** A write: sent once, never retried; whatever may have reached Discord throws `uncertain`. */
  write<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>
  /** The requests sent so far, the build number page included. */
  readonly requests: number
}

type Session = { token: string; hints: ClientHints; superProperties: string }

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lazyWreqTransport(os: ClientOs, loadTransport: NonNullable<DiscordClientOptions["loadTransport"]>): Transport {
  let loaded: Promise<Transport> | undefined
  return async (request) => {
    loaded ??= Promise.resolve()
      .then(() => loadTransport(os))
      .catch((error: unknown) => {
        loaded = undefined
        const detail = maskTokens(error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
        throw new ToolError(
          "internal_error",
          `The network library could not be loaded for ${process.platform}-${process.arch}: ${detail}`,
        )
      })
    return (await loaded)(request)
  }
}

function isIndexing(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { code?: unknown }).code === INDEXING_CODE
}

function checkedPath(value: string, what: string, forbidden: RegExp): string {
  if (!value.startsWith("/") || forbidden.test(value)) {
    throw new ToolError("internal_error", `Invalid ${what} ${JSON.stringify(value.slice(0, MAX_PATH_PREVIEW_LENGTH))}.`)
  }
  return value
}

/** The URL of a request; throws `internal_error` for a path or referer that is not what a tool may ask for. */
function requestUrl(path: string, request: RequestOptions): string {
  checkedPath(path, "Discord API path", /:\/\/|\.\.|[?#]|[\s\p{Cc}]/u)
  checkedPath(request.referer ?? DEFAULT_REFERER, "referer", /^\/\/|[\s\p{Cc}]/u)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return `${API_BASE}${path}${text ? `?${text}` : ""}`
}

/** Creates the client for one label; nothing is sent until the first request. */
export function createDiscordClient(options: DiscordClientOptions): DiscordClient {
  const os = options.os ?? clientOs()
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const transport =
    options.transport ??
    lazyWreqTransport(
      os,
      options.loadTransport ?? ((os) => import("./transport-wreq").then((module) => module.wreqTransport(os))),
    )
  const systemLocale = locale()
  const discordTag = discordLocale(systemLocale)
  const zone = timeZone()
  let requests = 0
  let session: Promise<Session> | undefined

  const assertBudget = (): void => {
    if (options.budget !== undefined && requests >= options.budget) throw new BudgetSpent()
  }

  const spend = (): void => {
    assertBudget()
    requests += 1
  }

  const paced = createPacer({ now, sleep, random })

  const prepare = async (): Promise<Session> => {
    const { token } = await readToken(options.paths, options.tokenVariable, options.env)
    const rejected = await rejectedAt(options.paths, token)
    if (rejected !== undefined) {
      const date = new Date(rejected)
      const when = Number.isNaN(date.getTime()) ? "an earlier time" : date.toISOString()
      throw new ToolError("unauthenticated", `Discord rejected this account's token at ${when}; give it a new token.`)
    }
    const build = await buildNumber({
      stateDir: options.stateDir,
      transport: (request) => {
        spend()
        return transport(request)
      },
      now,
      pace: async () => {
        assertBudget()
        await paced()
      },
    })
    const launch = await loadLaunch(options.paths, now())
    return {
      token,
      hints: clientHints(os),
      superProperties: superProperties({ os, buildNumber: build, launch, systemLocale }),
    }
  }

  const getSession = (): Promise<Session> => {
    session ??= prepare().catch((error: unknown) => {
      session = undefined
      throw error
    })
    return session
  }

  /** The error for a request that failed below HTTP: a read cannot be `uncertain`, a write that may have left is. */
  const transportError = (kind: RequestKind, current: Session, error: unknown, signal?: AbortSignal): unknown => {
    if (error instanceof ToolError && error.code === "internal_error") return error
    if (kind === "read" && signal?.aborted) return abortError(signal)
    const dispatched = error instanceof TransportFailure ? error.dispatched : true
    const detail = maskTokens(error instanceof Error ? error.message : String(error), current.token).slice(
      0,
      MAX_ERROR_DETAIL_LENGTH,
    )
    if (kind === "read") return new ToolError("upstream_error", `Could not reach Discord: ${detail}`)
    if (!dispatched) {
      return new ToolError("upstream_error", `Could not reach Discord; nothing was sent: ${detail}`)
    }
    return new ToolError("uncertain", "The request may have reached Discord; check before trying again.", {
      cause: new Error(detail),
    })
  }

  const exchange = async (
    kind: RequestKind,
    current: Session,
    method: string,
    url: string,
    request: RequestOptions,
  ): Promise<TransportResponse> => {
    if (request.signal?.aborted) throw abortError(request.signal)
    spend()
    await paced()
    if (request.signal?.aborted) throw abortError(request.signal)
    const body = request.body === undefined ? undefined : JSON.stringify(request.body)
    const outgoing: TransportRequest = {
      method,
      url,
      headers: requestHeaders({
        os,
        token: current.token,
        hints: current.hints,
        superProperties: current.superProperties,
        locale: discordTag,
        timeZone: zone,
        referer: request.referer ?? DEFAULT_REFERER,
        reason: request.reason,
        hasBody: body !== undefined,
      }),
      ...(body === undefined ? {} : { body }),
      timeoutMs: kind === "read" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
      ...(request.signal ? { signal: request.signal } : {}),
    }
    try {
      return await transport(outgoing)
    } catch (error) {
      throw transportError(kind, current, error, request.signal)
    }
  }

  /** The error for a non-2xx answer; a rejected token is recorded, and the next request checks the record. */
  const refusal = async (current: Session, response: TransportResponse, body: unknown): Promise<ToolError> => {
    if (response.status === 401 && !requiresTwoFactor(401, body)) {
      await recordRejected(options.paths, current.token, now()).catch(() => {})
      session = undefined
    }
    return httpError(response.status, response.headers, body, current.token)
  }

  const read = async <T>(method: string, path: string, request: RequestOptions = {}): Promise<T> => {
    const url = requestUrl(path, request)
    const current = await getSession()
    let waited = false
    for (;;) {
      const response = await exchange("read", current, method, url, request)
      const body = parseJson(response.body)
      const wait = retryAfter(response.headers, body)
      const indexing = response.status === 202 && isIndexing(body)
      const retryable = response.status === 429 || indexing
      const seconds = indexing ? wait || INDEXING_WAIT_S : wait
      if (retryable && !waited && seconds <= MAX_RATE_LIMIT_WAIT_S) {
        waited = true
        await sleep((seconds + RETRY_JITTER_MIN_S + random() * RETRY_JITTER_SPAN_S) * MS_PER_SECOND)
        continue
      }
      if (indexing) {
        throw new ToolError("rate_limited", "Discord is still indexing this search; try again in a minute")
      }
      if (response.status >= 200 && response.status < 300) {
        if (response.body.trim() === "") return undefined as T
        if (body === undefined) {
          throw new ToolError("upstream_error", "Discord answered with something that is not JSON.")
        }
        return body as T
      }
      throw await refusal(current, response, body)
    }
  }

  const write = async <T>(method: string, path: string, request: RequestOptions = {}): Promise<T> => {
    const url = requestUrl(path, request)
    const current = await getSession()
    const response = await exchange("write", current, method, url, request)
    const body = parseJson(response.body)
    if (response.status >= 200 && response.status < 300) {
      if (body !== undefined) return body as T
      if (response.body.trim() === "" && response.status === 204) return undefined as T
      throw new ToolError(
        "uncertain",
        `The request may have reached Discord (it answered ${response.status} without a usable answer); check before trying again.`,
      )
    }
    if (response.status >= 400 && response.status < 500) throw await refusal(current, response, body)
    throw new ToolError(
      "uncertain",
      `The request may have reached Discord (it answered ${response.status}); check before trying again.`,
    )
  }

  return {
    read,
    write,
    get requests() {
      return requests
    },
  }
}
