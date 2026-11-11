import { Buffer } from "node:buffer"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import { createGatewayInflater } from "./gateway-inflate"
import { type GatewayReady, parseReady } from "./gateway-ready"
import { isRecord } from "./ingest-values"
import { maskTokens } from "./mask"
import type { SocketEvent, TransportSocket } from "./transport"

export type { GatewayReady, ReadStateEntry } from "./gateway-ready"

/**
 * Where the web client connects: version 9, JSON, and one zlib context for the
 * whole connection (`zlib-stream`). Unconfirmed against Discord.
 */
export const GATEWAY_URL = "wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream"

/** How long a session waits for READY by default. */
export const GATEWAY_READY_TIMEOUT_MS = 30_000

/** The largest message accepted: READY of a large account is several MB packed. */
export const GATEWAY_MAX_PACKED_BYTES = 64 * 1024 * 1024

/** The most one payload may unpack to. */
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024

/** How long to wait for a closing socket to report it has closed before going on. */
const CLOSE_GRACE_MS = 2000

/** The close code of a session that ends as agreed. */
const CLOSE_NORMAL = 1000

/** Discord's close code for a token it does not accept. */
const CLOSE_AUTHENTICATION_FAILED = 4004

/** The gateway opcodes this session meets or sends. */
const OP_DISPATCH = 0
const OP_IDENTIFY = 2
const OP_INVALID_SESSION = 9
const OP_HELLO = 10

/**
 * The capability bits Identify asks for, and only these. `VERSIONED_READ_STATES`
 * (1 << 2) makes READY carry the read state as `{ entries, partial, version }`.
 * Every other bit the web client sets only shapes how much else READY holds,
 * which the session does not read. Unconfirmed against Discord.
 */
export const IDENTIFY_CAPABILITIES = 1 << 2

const MS_PER_SECOND = 1000
const MAX_CLOSE_DETAIL_LENGTH = 200

/**
 * The text of the Identify payload: the token, the capabilities, the web
 * client's own `properties` (the object `x-super-properties` encodes) and a
 * presence of `unknown` with no activities, so that the account is not shown
 * as online. Throws `internal_error` when the super properties cannot be read.
 */
export function identifyPayload(input: { token: string; superProperties: string }): string {
  let properties: unknown
  try {
    properties = JSON.parse(Buffer.from(input.superProperties, "base64").toString("utf8"))
  } catch (error) {
    throw new ToolError("internal_error", "The client properties could not be read for the gateway.", { cause: error })
  }
  return JSON.stringify({
    op: OP_IDENTIFY,
    d: {
      token: input.token,
      capabilities: IDENTIFY_CAPABILITIES,
      properties,
      presence: { status: "unknown", since: 0, activities: [], afk: false },
      compress: false,
      client_state: { guild_versions: {} },
    },
  })
}

/** What one session needs besides its socket. */
export type GatewaySessionOptions = {
  /** The Identify payload, as `identifyPayload` made it. */
  identify: string
  /** How long to wait for READY, counted from the start of the session. */
  timeoutMs: number
  signal?: AbortSignal
  now: () => number
}

const unreadable = () => new ToolError("upstream_error", "Discord's gateway sent something that could not be read.")

/** Thrown when Discord closes the session with 4004: the token is rejected, as a 401 says. The caller records and reports it. */
export class GatewayTokenRejected extends Error {
  constructor() {
    super(`Discord closed the gateway session with ${CLOSE_AUTHENTICATION_FAILED}.`)
    this.name = "GatewayTokenRejected"
  }
}

function closedBy(event: Extract<SocketEvent, { type: "close" }>): Error {
  if (event.code === CLOSE_AUTHENTICATION_FAILED) return new GatewayTokenRejected()
  if (event.error !== undefined) {
    return new ToolError("upstream_error", `Could not reach Discord's gateway: ${event.error}`)
  }
  const reason = maskTokens(event.reason).slice(0, MAX_CLOSE_DETAIL_LENGTH)
  return new ToolError(
    "upstream_error",
    `Discord's gateway closed the connection (code ${event.code}${reason ? `: ${reason}` : ""}).`,
  )
}

/** Rejects when the time is up or the signal aborts, and never otherwise. */
function interruption(timeoutMs: number, signal?: AbortSignal): { promise: Promise<never>; stop(): void } {
  let stop = () => {}
  const promise = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ToolError("upstream_error", `Discord's gateway sent no READY within ${timeoutMs / MS_PER_SECOND} s.`),
        ),
      timeoutMs,
    )
    const abort = () => reject(abortError(signal!))
    if (signal?.aborted) abort()
    signal?.addEventListener("abort", abort, { once: true })
    stop = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  })
  promise.catch(() => {})
  return { promise, stop }
}

async function closeSocket(socket: TransportSocket): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_GRACE_MS)))
  try {
    await Promise.race([socket.close(CLOSE_NORMAL), grace])
  } catch {
    // The connection is gone or going; there is nothing more to close.
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reads READY from a socket that was just opened, and nothing else: it sends
 * Identify when Hello arrives and no other frame, never a heartbeat (READY
 * comes long before the first is due), and ignores every other payload. The
 * socket is closed with 1000 before this settles, whatever the outcome.
 * Close 4004 rejects with `GatewayTokenRejected`; an invalid session (which
 * can be transient and says nothing of the token), any other end, data that
 * cannot be read and running out of time are `upstream_error`; an abort
 * rejects with an `AbortError`.
 */
export async function readGatewayReady(socket: TransportSocket, options: GatewaySessionOptions): Promise<GatewayReady> {
  const started = options.now()
  const interrupted = interruption(options.timeoutMs, options.signal)
  const inflater = createGatewayInflater({
    maxPackedBytes: GATEWAY_MAX_PACKED_BYTES,
    maxUnpackedBytes: MAX_UNPACKED_BYTES,
  })
  let identified = false
  try {
    for (;;) {
      const event = await Promise.race([interrupted.promise, socket.next()])
      if (event.type === "close") throw closedBy(event)
      const text =
        typeof event.data === "string"
          ? event.data
          : await inflater.push(event.data).catch(() => {
              throw unreadable()
            })
      if (text === undefined) continue
      const payload = parsePayload(text)
      if (payload.op === OP_HELLO && !identified) {
        identified = true
        try {
          socket.send(options.identify)
        } catch {
          throw new ToolError("upstream_error", "Discord's gateway closed before Identify could be sent.")
        }
      } else if (payload.op === OP_INVALID_SESSION) {
        throw new ToolError("upstream_error", "Discord's gateway ended the session before READY (invalid session).")
      } else if (payload.op === OP_DISPATCH && payload.t === "READY") {
        return { ...parseReady(payload.d), ms: options.now() - started }
      }
    }
  } finally {
    interrupted.stop()
    inflater.end()
    await closeSocket(socket)
  }
}

function parsePayload(text: string): { op?: unknown; t?: unknown; d?: unknown } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unreadable()
  }
  if (!isRecord(parsed)) throw unreadable()
  return parsed
}
