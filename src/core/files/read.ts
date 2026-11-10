import type { ChannelTarget } from "../chats/message-page"
import type { ChatSession } from "../chats/session"
import { ingestMessages } from "../discord/ingest"
import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { ToolError } from "../errors"

/** How many messages around the one to save the fresh read fetches. */
const AROUND_LIMIT = 5

/**
 * Reads the message again from Discord, for the signed URLs of what it
 * carries, and stores the page it came in like any live read (never as a
 * range, and nothing is deleted from the mirror). `not_found` when the page
 * does not hold the message any more; `upstream_error` when it is not a list.
 */
export async function readMessage(session: ChatSession, channel: ChannelTarget, message: string): Promise<JsonRecord> {
  const page = await session.client().read("GET", `/channels/${channel.id}/messages`, {
    query: { around: message, limit: AROUND_LIMIT },
    referer: channel.referer,
    signal: session.signal,
  })
  if (!Array.isArray(page)) {
    throw new ToolError(
      "upstream_error",
      `Discord answered the read of message ${message} with something else than a list.`,
    )
  }
  try {
    session.store((ctx) => ingestMessages(session.mirror, ctx, page, { reactions: true }))
  } catch {
    // What was read stays unstored; the files are saved all the same.
  }
  const found = page.filter(isRecord).find((candidate) => candidate.id === message)
  if (found === undefined) {
    throw new ToolError(
      "not_found",
      `Discord does not show message ${message} in channel ${channel.id} any more; it may have been deleted.`,
    )
  }
  return found
}
