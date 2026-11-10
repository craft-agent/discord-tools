import { ingestMessages, recordSend, settleSend } from "../discord/ingest"
import { knownChannelId } from "../chats/channel-target"
import { idTime } from "../chats/format"
import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import { isAbortError, isToolError, ToolError } from "../errors"
import { StepErrors, type ToolContext } from "../tool"
import { newNonce, READ_BACK_LIMIT, READ_BACK_SLACK_MS, readBackMatches, sendBody, sentMessage } from "./payload"
import type { SendInput, SendResult } from "./schemas"
import type { UploadedAttachment } from "./upload"

/** What every result says: where the message is stored, and that this tool cannot take it back. */
export const SEND_NOTE = "The message was stored in the local mirror. A sent message cannot be unsent by this tool."

/** What a result says when Discord took the message but the mirror did not store it. */
export const SENT_UNSTORED_NOTE =
  "The message was sent, but the local mirror could not store it (see `errors`); the next sync run picks it up. A sent message cannot be unsent by this tool."

/** The ledger code of a send that was cancelled before it left. */
const CANCELLED_CODE = "cancelled"

/** Whether a read-back ran: `skipped` when the call was cancelled by then, `failed` when it threw. */
type ReadBackStatus = "done" | "failed" | "skipped"

/** What a read-back looks for: the account's messages with this text, since a time, replying to the same message, and, for files, with as many attachments. */
type Look = { text: string; replyTo: string | undefined; since: number; attachments?: number }

/** What a send needs from the mirror before anything leaves: where it goes and, for a reply, the server for the reference. */
export type Destination = { id: string; referer: string; server: string | null }

/** What one message holds beyond the options every send shares. */
export type Post = {
  /** The text posted; empty when only files go. */
  text: string
  /** What the ledger hashes for the message: the text, and for files their hashes too. */
  ledgerText: string
  /** Uploads the files once the row is recorded and returns what the message names; a failure means nothing was posted. */
  upload?: () => Promise<UploadedAttachment[]>
}

/** Settles the ledger row. A database failure here never replaces the outcome the caller is about to report. */
function settle(session: ChatSession, nonce: string, outcome: Parameters<typeof settleSend>[3]): void {
  try {
    session.store((ctx) => settleSend(session.mirror, ctx, nonce, outcome))
  } catch {
    // The row stays pending; the outcome the caller reports is the one that matters.
  }
}

/** The ledger code of a send that failed before its message was requested: `cancelled`, the tool error's code, else `internal_error`. */
function unsentCode(error: unknown): string {
  if (isAbortError(error)) return CANCELLED_CODE
  return isToolError(error) ? error.code : "internal_error"
}

/** The chat to send to, and, for a reply, a check that the mirror holds the message in it; `not_found` or `invalid_argument` otherwise. */
export function destinationOf(
  session: ChatSession,
  { channel, reply_to }: Pick<SendInput, "channel" | "reply_to">,
): Destination {
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
 * Posts one message to a destination already checked. The ledger row is
 * committed before anything leaves; `post.upload`, when there is one, runs
 * next and a failure there settles the row `not_sent` (`cancelled` for an
 * abort) and rethrows, since nothing was posted. The message is then requested
 * once and never retried. A refusal, or a connection never made, settles the
 * row `not_sent` and rethrows; an abort is thrown by the client only before
 * dispatch, so it settles `not_sent` as cancelled. Anything else, including an
 * answer that is not the sent message, is `uncertain`.
 */
export async function postMessage(
  session: ChatSession,
  destination: Destination,
  args: Pick<SendInput, "reply_to" | "silent" | "mass_mentions">,
  post: Post,
): Promise<SendResult> {
  checkAbort(session.signal)
  const nonce = newNonce(session.now())
  const replyTo = args.reply_to
  const recorded = session.store((stored) =>
    recordSend(session.mirror, stored, {
      nonce,
      channel: destination.id,
      ...(replyTo === undefined ? {} : { replyTo }),
      text: post.ledgerText,
    }),
  )
  if (!recorded) throw new ToolError("internal_error", "The send could not be recorded, so nothing was sent.")

  let attachments: UploadedAttachment[] | undefined
  if (post.upload) {
    try {
      attachments = await post.upload()
    } catch (error) {
      settle(session, nonce, { status: "not_sent", code: unsentCode(error) })
      throw error
    }
  }

  const look: Look = {
    text: post.text,
    replyTo,
    since: session.now() - READ_BACK_SLACK_MS,
    ...(attachments ? { attachments: attachments.length } : {}),
  }
  const body = sendBody({
    text: post.text,
    nonce,
    silent: args.silent ?? false,
    massMentions: args.mass_mentions ?? false,
    ...(replyTo === undefined
      ? {}
      : { reply: { channel: destination.id, message: replyTo, server: destination.server } }),
    ...(attachments ? { attachments } : {}),
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
}

/** Sends one text: the destination is checked, then the message is posted as `postMessage` does. */
export async function sendMessage(args: SendInput, ctx: ToolContext): Promise<SendResult> {
  const session = await openChatSession(args, ctx)
  try {
    const destination = destinationOf(session, args)
    return await postMessage(session, destination, args, { text: args.text, ledgerText: args.text })
  } finally {
    session.close()
  }
}
