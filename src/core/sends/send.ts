import { ingestMessages, recordSend, settleSend } from "../discord/ingest"
import { knownChannelId } from "../chats/channel-target"
import { idTime } from "../chats/format"
import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import { isAbortError, isToolError, ToolError } from "../errors"
import { StepErrors, type ToolContext } from "../tool"
import { newNonce, READ_BACK_LIMIT, READ_BACK_SLACK_MS, readBackMatches, sendBody, sentMessage } from "./payload"
import type { SendInput, SendResult } from "./schemas"

/** What every result says: where the message is stored, and that this tool cannot take it back. */
export const SEND_NOTE = "The message was stored in the local mirror. A sent message cannot be unsent by this tool."

/** What a result says when Discord took the message but the mirror did not store it. */
export const SENT_UNSTORED_NOTE =
  "The message was sent, but the local mirror could not store it (see `errors`); the next sync run picks it up. A sent message cannot be unsent by this tool."

/** The ledger code of a send that was cancelled before it left. */
const CANCELLED_CODE = "cancelled"

/** Whether a read-back ran: `skipped` when the call was cancelled by then, `failed` when it threw. */
type ReadBackStatus = "done" | "failed" | "skipped"

/** What a read-back looks for: the account's messages with this text, since a time, replying to the same message. */
type Look = { text: string; replyTo: string | undefined; since: number }

/** What a send needs from the mirror before anything leaves: where it goes and, for a reply, the server for the reference. */
type Destination = { id: string; referer: string; server: string | null }

/** Settles the ledger row. A database failure here never replaces the outcome the caller is about to report. */
function settle(session: ChatSession, nonce: string, outcome: Parameters<typeof settleSend>[3]): void {
  try {
    session.store((ctx) => settleSend(session.mirror, ctx, nonce, outcome))
  } catch {
    // The row stays pending; the outcome the caller reports is the one that matters.
  }
}

/** The chat to send to, and, for a reply, a check that the mirror holds the message in it; `not_found` or `invalid_argument` otherwise. */
function destinationOf(session: ChatSession, { channel, reply_to }: SendInput): Destination {
  const { id, referer } = knownChannelId(session, channel)
  if (
    reply_to !== undefined &&
    !session.mirror.prepare("SELECT 1 FROM messages WHERE id = ? AND channel = ?").get(BigInt(reply_to), BigInt(id))
  ) {
    throw new ToolError(
      "not_found",
      `The mirror holds no message ${reply_to} in channel ${id}: read the chat with discord_chat_read first, then reply to a message it lists.`,
    )
  }
  const row = session.mirror
    .prepare("SELECT CAST(server AS TEXT) AS server FROM channels WHERE id = ?")
    .get(BigInt(id)) as { server: string | null } | undefined
  return { id, referer, server: row?.server ?? null }
}

/**
 * The read-back after an uncertain send: the channel's newest messages, stored
 * in the mirror (never as a range), and the ids among them that look like the
 * send. A failing read-back is reported, not thrown: the send is uncertain
 * either way.
 */
async function readBack(
  session: ChatSession,
  destination: Destination,
  look: Look,
): Promise<{ status: ReadBackStatus; matches: string[] }> {
  if (session.signal?.aborted) return { status: "skipped", matches: [] }
  try {
    const recent = await session.client().read("GET", `/channels/${destination.id}/messages`, {
      query: { limit: READ_BACK_LIMIT },
      referer: destination.referer,
      signal: session.signal,
    })
    const matches = readBackMatches(recent, { me: session.me, ...look })
    if (Array.isArray(recent)) {
      try {
        session.store((ctx) => ingestMessages(session.mirror, ctx, recent, { reactions: true }))
      } catch {
        // What was read stays unstored; the matches below are still the hint.
      }
    }
    return { status: "done", matches }
  } catch {
    return { status: "failed", matches: [] }
  }
}

/** Settles the send as uncertain, looks for it once, and throws `uncertain` with what was seen; it never reports success. */
async function failUncertain(
  session: ChatSession,
  destination: Destination,
  nonce: string,
  look: Look,
  cause?: unknown,
): Promise<never> {
  settle(session, nonce, { status: "uncertain", code: "uncertain" })
  const seen = await readBack(session, destination, look)
  throw new ToolError(
    "uncertain",
    "The message may have reached Discord, and it was not sent again. Check the chat before sending again (discord_chat_read method messages, live): `details.matches` lists the account's messages with the same text since this send.",
    {
      ...(cause instanceof Error ? { cause } : {}),
      details: { nonce, matches: seen.matches, read_back: seen.status },
    },
  )
}

/**
 * Sends one text. The ledger row is committed before the request leaves; the
 * request is sent once and never retried. A refusal, or a connection never
 * made, settles it `not_sent` and rethrows; an abort is thrown by the client
 * only before dispatch, so it settles `not_sent` as cancelled. Anything else,
 * including an answer that is not the sent message, is `uncertain`.
 */
export async function sendMessage(args: SendInput, ctx: ToolContext): Promise<SendResult> {
  const session = await openChatSession(args, ctx)
  try {
    const destination = destinationOf(session, args)
    checkAbort(session.signal)
    const nonce = newNonce(session.now())
    const replyTo = args.reply_to
    const recorded = session.store((stored) =>
      recordSend(session.mirror, stored, {
        nonce,
        channel: destination.id,
        ...(replyTo === undefined ? {} : { replyTo }),
        text: args.text,
      }),
    )
    if (!recorded) throw new ToolError("internal_error", "The send could not be recorded, so nothing was sent.")

    const look: Look = { text: args.text, replyTo, since: session.now() - READ_BACK_SLACK_MS }
    const body = sendBody({
      text: args.text,
      nonce,
      silent: args.silent ?? false,
      massMentions: args.mass_mentions ?? false,
      ...(replyTo === undefined
        ? {}
        : { reply: { channel: destination.id, message: replyTo, server: destination.server } }),
    })
    let answer: unknown
    try {
      answer = await session.client().write("POST", `/channels/${destination.id}/messages`, {
        body,
        referer: destination.referer,
        signal: session.signal,
      })
    } catch (error) {
      if (isAbortError(error)) {
        settle(session, nonce, { status: "not_sent", code: CANCELLED_CODE })
        throw error
      }
      if (isToolError(error) && error.code !== "uncertain") {
        settle(session, nonce, { status: "not_sent", code: error.code })
        throw error
      }
      return await failUncertain(session, destination, nonce, look, error)
    }

    const message = sentMessage(answer, { channel: destination.id, me: session.me, nonce })
    if (message === undefined) return await failUncertain(session, destination, nonce, look)
    const { id } = message
    // Discord created the message: a failure to store it is reported, never thrown.
    // The ledger settles on its own, so it keeps the message id even when storing the message fails.
    const steps = new StepErrors()
    await steps.record("ledger", async () =>
      session.store((stored) => settleSend(session.mirror, stored, nonce, { status: "sent", message: id })),
    )
    await steps.record("store", async () =>
      session.store((stored) => ingestMessages(session.mirror, stored, [message], { reactions: true })),
    )
    return {
      id,
      channel: destination.id,
      sent_at: idTime(id),
      reply_to: replyTo ?? null,
      silent: args.silent ?? false,
      note: steps.any ? SENT_UNSTORED_NOTE : SEND_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}
