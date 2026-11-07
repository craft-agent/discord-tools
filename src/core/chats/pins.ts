import { ingestMessages } from "../discord/ingest"
import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { isSnowflake } from "../discord/snowflake"
import { invalidResponse } from "../discord/sync-page"
import { PINS_LIMIT_DEFAULT } from "./args"
import { parsePinTime } from "./bounds"
import { knownChannel } from "./channel-target"
import { messageItems, reactionsNote } from "./message-items"
import type { ChatHandler } from "./session"

type Pin = { pinned_at: string; message: JsonRecord }

/**
 * Validates a pins response: an object whose `items` hold at most `limit`
 * pins, each with a parseable `pinned_at` and a message of `channel` with a
 * snowflake id (distinct across the page) and text, and a boolean `has_more`.
 */
function pinsPage(value: unknown, channel: string, limit: number): { pins: Pin[]; hasMore: boolean } {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > limit) invalidResponse()
  if (typeof value.has_more !== "boolean") invalidResponse()
  const seen = new Set<string>()
  const pins = value.items.map((item): Pin => {
    if (!isRecord(item) || typeof item.pinned_at !== "string" || Number.isNaN(Date.parse(item.pinned_at))) {
      invalidResponse()
    }
    const message = item.message
    if (
      !isRecord(message) ||
      !isSnowflake(message.id) ||
      seen.has(message.id) ||
      message.channel_id !== channel ||
      typeof message.content !== "string"
    ) {
      invalidResponse()
    }
    seen.add(message.id)
    return { pinned_at: item.pinned_at, message }
  })
  return { pins, hasMore: value.has_more }
}

/**
 * Method `pins`: a chat's pinned messages, newest pin first, read from Discord
 * and stored. The page is not contiguous history, so it deletes nothing and
 * keeps stored reactions; `before` is a pin time, and `next_before` the pin
 * time of the last item.
 */
export const readPins: ChatHandler = async (session, args) => {
  const channel = knownChannel(session, args)
  const limit = args.limit ?? PINS_LIMIT_DEFAULT
  const before = args.before === undefined ? undefined : parsePinTime(args.before)
  const value = await session.client().read("GET", `/channels/${channel.id}/messages/pins`, {
    query: { limit, before },
    referer: channel.referer,
    ...(session.signal ? { signal: session.signal } : {}),
  })
  const { pins, hasMore } = pinsPage(value, channel.id, limit)
  session.store((ctx) =>
    ingestMessages(
      session.mirror,
      ctx,
      pins.map((pin) => pin.message),
      { reactions: false },
    ),
  )

  const stored = new Map(
    messageItems(
      session,
      channel.id,
      pins.map((pin) => pin.message.id as string),
    ).map((item) => [item.id, item]),
  )
  const items = pins.flatMap((pin) => {
    const message = stored.get(pin.message.id as string)
    return message ? [{ pinned_at: pin.pinned_at, message }] : []
  })
  return {
    source: "live",
    channel: channel.id,
    pins: items,
    next_before: hasMore ? (pins.at(-1)?.pinned_at ?? null) : null,
    ...reactionsNote(items.map((item) => item.message)),
  }
}
