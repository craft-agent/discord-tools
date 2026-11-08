import { createHash } from "node:crypto"
import type { IngestContext } from "./ingest-context"
import { idOrNull } from "./ingest-values"
import type { Mirror } from "./mirror"

/** How many days a settled or unsettled send ledger row is kept. */
export const SEND_LEDGER_DAYS = 30

/** Milliseconds in one day, for the ledger's creation-time cutoff. */
const DAY_MS = 24 * 60 * 60 * 1000

/** One send ledger row, with ids read as text and absent columns as null. */
type SendRow = {
  nonce: string
  channel: string
  replyTo: string | null
  textHash: string
  created: number
  status: "pending" | "sent" | "not_sent" | "uncertain"
  message: string | null
  code: string | null
  settled: number | null
}

/** The SHA-256 hex digest of the UTF-8 text, without storing the text. */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Prunes expired rows and records a pending send in the caller's transaction.
 * Returns whether the row was written: a send whose ids are not valid is not
 * recorded, and must not leave.
 */
export function recordSend(
  mirror: Mirror,
  ctx: IngestContext,
  send: { nonce: string; channel: string; replyTo?: string; text: string },
): boolean {
  mirror.prepare("DELETE FROM sends WHERE created < ?").run(ctx.now - SEND_LEDGER_DAYS * DAY_MS)
  const nonce = idOrNull(send.nonce)
  const channel = idOrNull(send.channel)
  const replyTo = send.replyTo === undefined ? null : idOrNull(send.replyTo)
  if (nonce === null || channel === null || (send.replyTo !== undefined && replyTo === null)) return false
  mirror
    .prepare(
      "INSERT INTO sends (nonce, channel, reply_to, text_hash, created, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    )
    .run(nonce, channel, replyTo, textHash(send.text), ctx.now)
  return true
}

/** Settles only a pending send, never overwriting an already settled outcome; invalid ids are skipped. */
export function settleSend(
  mirror: Mirror,
  ctx: IngestContext,
  nonce: string,
  outcome: { status: "sent"; message: string } | { status: "not_sent" | "uncertain"; code: string },
): void {
  const nonceId = idOrNull(nonce)
  const message = outcome.status === "sent" ? idOrNull(outcome.message) : null
  if (nonceId === null || (outcome.status === "sent" && message === null)) return
  mirror
    .prepare("UPDATE sends SET status = ?, message = ?, code = ?, settled = ? WHERE nonce = ? AND status = 'pending'")
    .run(outcome.status, message, outcome.status === "sent" ? null : outcome.code, ctx.now, nonceId)
}

/** Reads one send ledger row by nonce, preserving ids above 2^53 as text. */
export function getSend(mirror: Mirror, nonce: string): SendRow | undefined {
  const nonceId = idOrNull(nonce)
  if (nonceId === null) return undefined
  return mirror
    .prepare(
      `SELECT CAST(nonce AS TEXT) AS nonce, CAST(channel AS TEXT) AS channel,
        CAST(reply_to AS TEXT) AS replyTo, text_hash AS textHash, created, status,
        CAST(message AS TEXT) AS message, code, settled FROM sends WHERE nonce = ?`,
    )
    .get(nonceId) as SendRow | undefined
}
