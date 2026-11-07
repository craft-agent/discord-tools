import { ToolError } from "../errors"
import { ingestHistoryPage } from "../discord/ingest"
import { historyPage } from "../discord/sync-page"
import { AROUND_COUNT_DEFAULT, MESSAGES_LIMIT_MAX, requireMessage } from "./args"
import { knownChannel } from "./channel-target"
import { messageItems, reactionsNote } from "./message-items"
import type { ChannelTarget } from "./message-page"
import type { ChatHandler, ChatSession } from "./session"
import { vouchedHead, vouchedRange } from "./vouched"

/** How many messages to return on each side of the one asked for. */
type Counts = { older: number; newer: number }

type IdRow = { id: string }

/** Ids of a channel's messages on one side of `anchor`, nearest first, from `atLeast` up to `atMost`. */
function neighbours(
  session: ChatSession,
  channel: string,
  anchor: bigint,
  side: "older" | "newer",
  limit: number,
  bounds: { atLeast: bigint; atMost: bigint },
): string[] {
  const [test, order] = side === "older" ? ["<", "DESC"] : [">", "ASC"]
  const rows = session.mirror
    .prepare(
      `SELECT CAST(id AS TEXT) AS id FROM messages WHERE channel = ? AND id ${test} ? AND id >= ? AND id <= ? ORDER BY id ${order} LIMIT ?`,
    )
    .all(BigInt(channel), anchor, bounds.atLeast, bounds.atMost, limit)
  return (rows as IdRow[]).map((row) => row.id)
}

/**
 * The ids around `anchor` from the mirror, oldest first, or `null` when it
 * cannot answer: the channel is not current, the anchor is not mirrored inside
 * the vouched part of the history (from its oldest up to its newest), or fewer
 * older messages are mirrored than asked for while older ones may exist.
 */
function aroundFromMirror(session: ChatSession, channel: string, anchor: string, counts: Counts): string[] | null {
  const vouched = vouchedRange(session, channel)
  const id = BigInt(anchor)
  if (!vouched) return null
  const atMost = vouchedHead(vouched)
  if (id < vouched.oldest || id > atMost) return null
  if (!session.mirror.prepare("SELECT 1 FROM messages WHERE channel = ? AND id = ?").get(BigInt(channel), id)) {
    return null
  }
  const bounds = { atLeast: vouched.oldest, atMost }
  const older = neighbours(session, channel, id, "older", counts.older, bounds)
  if (older.length < counts.older && !vouched.complete) return null
  const newer = neighbours(session, channel, id, "newer", counts.newer, bounds)
  return [...older.reverse(), anchor, ...newer]
}

/**
 * The ids around `anchor` from Discord, oldest first. The page is stored and
 * vouches only for the ids strictly between its oldest and newest message:
 * nothing at or beyond its edges is known to be contiguous.
 */
async function aroundFromDiscord(
  session: ChatSession,
  channel: ChannelTarget,
  anchor: string,
  counts: Counts,
): Promise<string[]> {
  const limit = Math.min(2 * Math.max(counts.older, counts.newer) + 1, MESSAGES_LIMIT_MAX)
  const value = await session.client().read("GET", `/channels/${channel.id}/messages`, {
    query: { around: anchor, limit },
    referer: channel.referer,
    ...(session.signal ? { signal: session.signal } : {}),
  })
  const page = historyPage(value, channel.id, limit)
  if (page.newest !== undefined && page.oldest !== undefined) {
    const range = { after: page.oldest, before: page.newest }
    session.store((ctx) => ingestHistoryPage(session.mirror, ctx, channel.id, page.messages, range))
  }
  const ids = page.messages.map((message) => message.id as string).reverse()
  const at = ids.indexOf(anchor)
  if (at < 0) {
    throw new ToolError("not_found", `Message ${anchor} is not in channel ${channel.id}, or was deleted.`)
  }
  return ids.slice(Math.max(0, at - counts.older), at + 1 + counts.newer)
}

/**
 * Method `around`: a message with the ones just before and after it, oldest
 * first. From the mirror while the chat is current and holds the message and
 * enough older ones, else from Discord, storing the page.
 */
export const readAround: ChatHandler = async (session, args) => {
  const channel = knownChannel(session, args)
  const anchor = requireMessage(args)
  const counts = { older: args.before_count ?? AROUND_COUNT_DEFAULT, newer: args.after_count ?? AROUND_COUNT_DEFAULT }
  const fromMirror = aroundFromMirror(session, channel.id, anchor, counts)
  const ids = fromMirror ?? (await aroundFromDiscord(session, channel, anchor, counts))
  const messages = messageItems(session, channel.id, ids)
  return {
    source: fromMirror ? "mirror" : "live",
    channel: channel.id,
    message: anchor,
    messages,
    ...reactionsNote(messages),
  }
}
