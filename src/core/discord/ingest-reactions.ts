import { newCounts, type IngestCounts } from "./ingest-context"
import { storedReactions, type StoredReaction } from "./ingest-parts"
import { idOrNull, jsonOrNull } from "./ingest-values"
import type { Mirror } from "./mirror"

/** `reactions` with the account's own reaction to `emoji` added; the same list when it is already there. */
function withOwnReaction(reactions: StoredReaction[], emoji: string): StoredReaction[] {
  const found = reactions.find((reaction) => reaction.emoji === emoji)
  if (!found) return [...reactions, { emoji, count: 1, me: true }]
  if (found.me) return reactions
  return reactions.map((reaction) => (reaction === found ? { ...found, count: found.count + 1, me: true } : reaction))
}

/** `reactions` without the account's own reaction to `emoji`, the entry dropped at zero; the same list when it holds none. */
function withoutOwnReaction(reactions: StoredReaction[], emoji: string): StoredReaction[] {
  const found = reactions.find((reaction) => reaction.emoji === emoji)
  if (!found?.me) return reactions
  const count = found.count - 1
  if (count <= 0) return reactions.filter((reaction) => reaction !== found)
  return reactions.map((reaction) => (reaction === found ? { ...found, count, me: false } : reaction))
}

/**
 * Follows the account's own reaction on a stored message after Discord took
 * it: adds it (counting it in and marking `me`), or takes it back. `emoji` is
 * the `emojiKey` spelling. Counts the change as stored; a message the mirror
 * does not hold, an invalid id and a reactions column that is not shaped as
 * `reactionsJson` writes it are skipped and left as they are.
 */
export function adjustOwnReaction(mirror: Mirror, id: string, emoji: string, add: boolean): IngestCounts {
  const counts = newCounts()
  const messageId = idOrNull(id)
  const row =
    messageId === null
      ? undefined
      : (mirror.prepare("SELECT reactions FROM messages WHERE id = ?").get(messageId) as
          { reactions: string | null } | undefined)
  const current = row ? storedReactions(row.reactions) : null
  if (messageId === null || current === null) {
    counts.skipped += 1
    return counts
  }
  const next = add ? withOwnReaction(current, emoji) : withoutOwnReaction(current, emoji)
  if (next !== current) {
    mirror.prepare("UPDATE messages SET reactions = ? WHERE id = ?").run(jsonOrNull(next), messageId)
    counts.stored += 1
  }
  return counts
}
