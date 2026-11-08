import { ingestHistoryPage } from "../discord/ingest"
import { forwardPage, historyPage, type HistoryPage } from "../discord/sync-page"
import type { MessagePage, MessageRequest } from "./message-page"
import type { ChatSession } from "./session"

/**
 * Reads a `messages` request from Discord and stores the page, which vouches
 * for the range it covers: a mirrored message inside it that Discord did not
 * return is deleted. Nothing else changes: the channel is not marked current
 * and the cursor's edges stay.
 */
export async function messagesFromDiscord(session: ChatSession, request: MessageRequest): Promise<MessagePage> {
  const { channel, limit } = request
  const from = request.direction === "forward" ? request.after : undefined
  const value = await session.client().read("GET", `/channels/${channel.id}/messages`, {
    query: from === undefined ? { limit, before: request.before } : { limit, after: from },
    referer: channel.referer,
    ...(session.signal ? { signal: session.signal } : {}),
  })
  const page: HistoryPage =
    from === undefined
      ? historyPage(value, channel.id, limit, request.before)
      : forwardPage(value, channel.id, limit, from)
  session.store((ctx) => ingestHistoryPage(session.mirror, ctx, channel.id, page.messages, page.range))

  const ids = page.messages.map((message) => message.id as string).reverse()
  if (from !== undefined) {
    return { ids, next_before: null, next_after: page.last ? null : (ids.at(-1) ?? null) }
  }
  const floor = request.after === undefined ? undefined : BigInt(request.after)
  const kept = floor === undefined ? ids : ids.filter((id) => BigInt(id) > floor)
  const reachedFloor = kept.length < ids.length
  return { ids: kept, next_before: page.last || reachedFloor ? null : (kept[0] ?? null), next_after: null }
}
