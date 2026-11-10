import { type FileHandle, unlink } from "node:fs/promises"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import { buildNumber } from "./build-number"
import {
  type DownloadOptions,
  type DownloadResult,
  NOT_MEDIA_URL,
  createDownloadFile,
  mediaUrl,
  receiveDownload,
} from "./download"
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
import { DEFAULT_REFERER, REQUEST_HEADER_ORDER, mediaHeaders, requestHeaders, uploadHeaders } from "./request-headers"
import { readToken, recordRejected, rejectedAt } from "./token"
import {
  type DownloadTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  TransportFailure,
} from "./transport"
import { type UploadOptions, type UploadResult, NOT_STORAGE_URL, storageUrl } from "./upload"

export { REQUEST_HEADER_ORDER }
export { isMediaUrl } from "./download"
export { isStorageUrl } from "./upload"
export type { DownloadOptions, DownloadResult, UploadOptions, UploadResult }

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

/** A referer that is not a path on the web client's own origin. */
const FORBIDDEN_REFERER = /^\/\/|[\s\p{Cc}]/u

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
  /** A list is sent as one key per element; an empty list sends none. */
  query?: Record<string, string | number | boolean | readonly (string | number)[] | undefined>
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
  /** Sends the downloads; by default Chrome's fingerprint through wreq, loaded on first use. */
  download?: DownloadTransport
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
  /**
   * Saves a file from Discord's media hosts to `options.to`: paced and counted
   * like any request, but without the token, a build number or the API's
   * headers, never retried and never following a redirect. Only a `saved`
   * result leaves a file. See `DownloadResult` for the other outcomes.
   */
  download(url: string, options: DownloadOptions): Promise<DownloadResult>
  /**
   * Puts `body` to a signed URL on Discord's storage: paced and counted like
   * any request, but without the token, a build number or the API's headers,
   * never retried and never following a redirect. A URL elsewhere is `refused`
   * with no request. See `UploadResult` for the other outcomes.
   */
  upload(url: string, body: Uint8Array, options: UploadOptions): Promise<UploadResult>
  /** The requests sent so far, the build number page and the uploads and downloads included. */
  readonly requests: number
}

type Session = { token: string; hints: ClientHints; superProperties: string }

/** Keeps post-pacing disk checks inside the process-wide dispatch turn, without holding it for the response. */
let dispatchQueue: Promise<void> = Promise.resolve()

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rebuilds exposed errors without retaining a raw cause or stack from a token-aware boundary. */
function sanitizedError(error: unknown, token: string): Error {
  if (error instanceof BudgetSpent) return error
  const message = maskTokens(error instanceof Error ? error.message : String(error), token)
  const cause =
    error instanceof Error && error.cause !== undefined
      ? { cause: new Error(maskTokens(String(error.cause), token)) }
      : undefined
  if (error instanceof ToolError) {
    return new ToolError(error.code, message, { ...cause, ...(error.details ? { details: error.details } : {}) })
  }
  const safe = new Error(message, cause)
  safe.name = error instanceof Error ? maskTokens(error.name, token) : "Error"
  return safe
}

/** The result for a download that failed below HTTP or on the disk; its text is masked like any error's. */
function failedDownload(prefix: string, error: unknown): DownloadResult {
  const detail = maskTokens(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_DETAIL_LENGTH)
  return { status: "failed", why: `${prefix}: ${detail}` }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function lazyWreq<Answer>(
  load: () => Promise<(request: TransportRequest) => Promise<Answer>>,
): (request: TransportRequest) => Promise<Answer> {
  let loaded: Promise<(request: TransportRequest) => Promise<Answer>> | undefined
  return async (request) => {
    loaded ??= Promise.resolve()
      .then(load)
      .catch((error: unknown) => {
        loaded = undefined
        const detail = maskTokens(error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]
        throw new ToolError(
          "internal_error",
          `The network library could not be loaded for ${process.platform}-${process.arch}: ${detail}`,
        )
      })
    const transport = await loaded
    checkAbort(request.signal)
    return transport(request)
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
  checkedPath(request.referer ?? DEFAULT_REFERER, "referer", FORBIDDEN_REFERER)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (typeof value === "object") {
      for (const element of value) search.append(key, String(element))
    } else if (value !== undefined) {
      search.set(key, String(value))
    }
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
    lazyWreq(() =>
      (options.loadTransport ?? ((os) => import("./transport-wreq").then((module) => module.wreqTransport(os))))(os),
    )
  const sendDownload =
    options.download ?? lazyWreq(() => import("./transport-wreq").then((module) => module.wreqDownload(os)))
  const systemLocale = locale()
  const discordTag = discordLocale(systemLocale)
  const zone = timeZone()
  let requests = 0
  let session: Promise<Session> | undefined
  let sessionSignal: AbortSignal | undefined

  const assertBudget = (): void => {
    if (options.budget !== undefined && requests >= options.budget) throw new BudgetSpent()
  }

  const spend = (): void => {
    assertBudget()
    requests += 1
  }

  const paced = createPacer({ now, sleep, random })

  const checkRejected = async (token: string): Promise<void> => {
    const rejected = await rejectedAt(options.paths, token)
    if (rejected !== undefined) {
      const date = new Date(rejected)
      const when = Number.isNaN(date.getTime()) ? "an earlier time" : date.toISOString()
      throw new ToolError("unauthenticated", `Discord rejected this account's token at ${when}; give it a new token.`)
    }
  }

  const dispatchWith = async <Answer>(
    request: TransportRequest,
    send: (request: TransportRequest) => Promise<Answer>,
    token?: string,
  ): Promise<Answer> => {
    const turn = dispatchQueue.then(async () => {
      checkAbort(request.signal)
      assertBudget()
      await paced()
      checkAbort(request.signal)
      if (token !== undefined) await checkRejected(token)
      checkAbort(request.signal)
      spend()
      return { response: send(request) }
    })
    dispatchQueue = turn.then(
      () => {},
      () => {},
    )
    return (await turn).response
  }

  const dispatch = (
    request: TransportRequest,
    send: Transport = transport,
    token?: string,
  ): Promise<TransportResponse> => dispatchWith(request, send, token)

  const prepare = async (signal?: AbortSignal): Promise<Session> => {
    checkAbort(signal)
    const { token } = await readToken(options.paths, options.tokenVariable, options.env)
    try {
      checkAbort(signal)
      await checkRejected(token)
      const build = await buildNumber({
        stateDir: options.stateDir,
        transport: (request) => dispatch(request),
        now,
        pace: async () => {
          checkAbort(signal)
          assertBudget()
        },
        ...(signal ? { signal } : {}),
      })
      checkAbort(signal)
      const launch = await loadLaunch(options.paths, now())
      checkAbort(signal)
      return {
        token,
        hints: clientHints(os),
        superProperties: superProperties({ os, buildNumber: build, launch, systemLocale }),
      }
    } catch (error) {
      throw sanitizedError(error, token)
    }
  }

  const getSession = async (signal?: AbortSignal): Promise<Session> => {
    for (;;) {
      checkAbort(signal)
      if (!session) {
        sessionSignal = signal
        session = prepare(signal)
      }
      const pending = session
      const ownerSignal = sessionSignal
      try {
        return await pending
      } catch (error) {
        if (session === pending) session = undefined
        if (ownerSignal?.aborted && ownerSignal !== signal && !signal?.aborted) continue
        throw error
      }
    }
  }

  /** The error for a request that failed below HTTP: a read cannot be `uncertain`, a write that may have left is. */
  const transportError = (kind: RequestKind, current: Session, error: unknown, signal?: AbortSignal): unknown => {
    if (kind === "read" && signal?.aborted) return abortError(signal)
    if (error instanceof ToolError && error.code === "internal_error") return sanitizedError(error, current.token)
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
    checkAbort(request.signal)
    await checkRejected(current.token)
    checkAbort(request.signal)
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
    return dispatch(
      outgoing,
      async (outgoing) => {
        try {
          const response = await transport(outgoing)
          if (request.signal?.aborted) throw new TransportFailure("The operation was aborted", true)
          return response
        } catch (error) {
          throw transportError(kind, current, error, request.signal)
        }
      },
      current.token,
    )
  }

  /** The error for a non-2xx answer; a rejected token is recorded, and the next request checks the record. */
  const refusal = async (current: Session, response: TransportResponse, body: unknown): Promise<ToolError> => {
    if (response.status === 401 && !requiresTwoFactor(401, body)) {
      await recordRejected(options.paths, current.token, now()).catch(() => {})
      session = undefined
    }
    return httpError(response.status, response.headers, body, current.token)
  }

  const withSession = async <T>(
    path: string,
    request: RequestOptions,
    run: (current: Session, url: string) => Promise<T>,
  ): Promise<T> => {
    checkAbort(request.signal)
    const url = requestUrl(path, request)
    const current = await getSession(request.signal)
    try {
      checkAbort(request.signal)
      return await run(current, url)
    } catch (error) {
      throw sanitizedError(error, current.token)
    }
  }

  const read = async <T>(method: string, path: string, request: RequestOptions = {}): Promise<T> => {
    return withSession(path, request, async (current, url) => {
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
    })
  }

  const write = async <T>(method: string, path: string, request: RequestOptions = {}): Promise<T> => {
    return withSession(path, request, async (current, url) => {
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
    })
  }

  const downloadFile = async (url: string, request: DownloadOptions): Promise<DownloadResult> => {
    checkAbort(request.signal)
    const target = mediaUrl(url)
    if (!target) return { status: "refused", why: NOT_MEDIA_URL }
    if (request.declaredSize !== undefined && request.declaredSize > request.maxBytes) return { status: "too_large" }
    let file: FileHandle
    try {
      file = await createDownloadFile(request.to)
    } catch (error) {
      return failedDownload("Could not create the file", error)
    }
    const expired = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal, expired.signal]) : expired.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let saved = false
    try {
      const response = await dispatchWith(
        {
          method: "GET",
          url: target.href,
          headers: mediaHeaders({ os, hints: clientHints(os), locale: discordTag }),
          timeoutMs: request.timeoutMs,
          signal,
        },
        (outgoing) => {
          // The limit counts from the send, not from the wait for the turn.
          timer = setTimeout(() => expired.abort(), request.timeoutMs)
          return sendDownload(outgoing)
        },
      )
      const result = await receiveDownload(response, file, request.maxBytes)
      await file.close()
      saved = result.status === "saved"
      return result
    } catch (error) {
      if (request.signal?.aborted) throw abortError(request.signal)
      if (error instanceof BudgetSpent || error instanceof ToolError) throw error
      if (expired.signal.aborted) {
        return { status: "failed", why: `The download took longer than ${request.timeoutMs / MS_PER_SECOND} seconds.` }
      }
      return failedDownload("Could not download the file", error)
    } finally {
      clearTimeout(timer)
      await file.close().catch(() => {})
      if (!saved) await unlink(request.to).catch(() => {})
    }
  }

  const uploadFile = async (url: string, body: Uint8Array, request: UploadOptions): Promise<UploadResult> => {
    checkAbort(request.signal)
    const target = storageUrl(url)
    if (!target) return { status: "refused", why: NOT_STORAGE_URL }
    checkedPath(request.referer, "referer", FORBIDDEN_REFERER)
    try {
      const response = await dispatchWith(
        {
          method: "PUT",
          url: target.href,
          headers: uploadHeaders({ os, hints: clientHints(os), locale: discordTag, referer: request.referer }),
          body,
          timeoutMs: request.timeoutMs,
          ...(request.signal ? { signal: request.signal } : {}),
        },
        transport,
      )
      if (response.status >= 200 && response.status < 300) return { status: "uploaded" }
      return { status: "failed", why: `Discord's storage answered ${response.status}`, dispatched: true }
    } catch (error) {
      if (request.signal?.aborted) throw abortError(request.signal)
      if (error instanceof BudgetSpent || error instanceof ToolError) throw error
      const detail = maskTokens(error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_ERROR_DETAIL_LENGTH,
      )
      return {
        status: "failed",
        why: detail,
        dispatched: error instanceof TransportFailure ? error.dispatched : true,
      }
    }
  }

  return {
    read,
    write,
    download: downloadFile,
    upload: uploadFile,
    get requests() {
      return requests
    },
  }
}
