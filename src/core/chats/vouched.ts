import { getCursor, isChannelCurrent } from "../discord/mirror-cursors"
import type { ChatSession } from "./session"

/** The part of a channel the mirror vouches for: every id from `oldest` up to `newest`. */
export type Vouched = {
  oldest: bigint
  /** The newest id the mirror vouches for, or `null` when the cursor holds none and nothing is vouched. */
  newest: bigint | null
  /** Whether the mirror reaches the channel's first message, so nothing lies below `oldest`. */
  complete: boolean
}

/**
 * What the mirror vouches for in a channel, or `null` when it may not answer:
 * the channel was not marked current in the last 15 minutes, or its mirrored
 * range is not known.
 */
export function vouchedRange(session: ChatSession, channel: string): Vouched | null {
  if (!isChannelCurrent(session.mirror, channel, session.now())) return null
  const cursor = getCursor(session.mirror, channel)
  if (!cursor || (cursor.oldest === null && !cursor.complete)) return null
  return {
    oldest: BigInt(cursor.oldest ?? "0"),
    newest: cursor.newest === null ? null : BigInt(cursor.newest),
    complete: cursor.complete,
  }
}

/** The highest id a mirror answer may hold: `newest`, or one below `oldest` (no id at all) when none is vouched. */
export function vouchedHead(vouched: Vouched): bigint {
  return vouched.newest ?? vouched.oldest - 1n
}
