import { fieldOf, idText, intOrNull, isRecord, jsonOrNull, listOf, textOrNull } from "./ingest-values"

/** Longest kept text of each readable part of an embed, in characters. */
const EMBED_LIMITS = { title: 256, description: 500, url: 300, author: 100, site: 100, footer: 200 } as const

/** Embed fields kept, and the longest name and value of each. */
const EMBED_FIELD_COUNT = 5
const EMBED_FIELD_NAME_LIMIT = 100
const EMBED_FIELD_VALUE_LIMIT = 300

/** `value` cut to `limit` characters (code points), or `null` when it is not a non-empty string. */
function clip(value: unknown, limit: number): string | null {
  const text = textOrNull(value)
  if (text === null) return null
  return text.length <= limit ? text : Array.from(text).slice(0, limit).join("")
}

/** A reaction's emoji as the API path and the mirror spell it: the character, or `name:id` (`_:id` when the name is missing); `null` for no emoji or an invalid id. */
export function emojiKey(emoji: unknown): string | null {
  if (!isRecord(emoji)) return null
  const name = textOrNull(emoji.name)
  if (emoji.id === undefined || emoji.id === null) return name
  const id = idText(emoji.id)
  return id ? `${name ?? "_"}:${id}` : null
}

/** The readable part of each embed (link previews, bot cards) as JSON, clipped; `null` when there is none. */
export function embedsJson(value: unknown): string | null {
  const embeds = listOf(value).flatMap((embed) => {
    if (!isRecord(embed)) return []
    const fields = listOf(embed.fields)
      .slice(0, EMBED_FIELD_COUNT)
      .flatMap((field) =>
        isRecord(field)
          ? [
              {
                name: clip(field.name, EMBED_FIELD_NAME_LIMIT) ?? "",
                value: clip(field.value, EMBED_FIELD_VALUE_LIMIT) ?? "",
              },
            ]
          : [],
      )
    const parts = {
      title: clip(embed.title, EMBED_LIMITS.title),
      description: clip(embed.description, EMBED_LIMITS.description),
      url: clip(embed.url, EMBED_LIMITS.url),
      author: clip(fieldOf(embed.author, "name"), EMBED_LIMITS.author),
      site: clip(fieldOf(embed.provider, "name"), EMBED_LIMITS.site),
      footer: clip(fieldOf(embed.footer, "text"), EMBED_LIMITS.footer),
      fields: fields.length > 0 ? fields : null,
    }
    const kept = Object.entries(parts).filter(([, part]) => part !== null)
    return kept.length > 0 ? [Object.fromEntries(kept)] : []
  })
  return jsonOrNull(embeds)
}

/** Attachments as `[{id, name, type, size, url}]` JSON; `null` when there are none. */
export function attachmentsJson(value: unknown): string | null {
  return jsonOrNull(
    listOf(value).flatMap((attachment) =>
      isRecord(attachment)
        ? [
            {
              id: idText(attachment.id),
              name: textOrNull(attachment.filename),
              type: textOrNull(attachment.content_type),
              size: intOrNull(attachment.size),
              url: textOrNull(attachment.url),
            },
          ]
        : [],
    ),
  )
}

/** Stickers (`sticker_items`) as `[{id, name}]` JSON; `null` when there are none. */
export function stickersJson(value: unknown): string | null {
  return jsonOrNull(
    listOf(value).flatMap((sticker) => {
      const id = idText(fieldOf(sticker, "id"))
      return id ? [{ id, name: textOrNull(fieldOf(sticker, "name")) }] : []
    }),
  )
}

/** Reactions as `[{emoji, count, me}]` JSON; `null` when there are none. */
export function reactionsJson(value: unknown): string | null {
  return jsonOrNull(
    listOf(value).flatMap((reaction) => {
      const emoji = emojiKey(fieldOf(reaction, "emoji"))
      if (!emoji || !isRecord(reaction)) return []
      return [{ emoji, count: intOrNull(reaction.count) ?? 0, me: reaction.me === true }]
    }),
  )
}

/** One entry of the stored reactions: `emoji` is the `emojiKey` spelling. */
export type StoredReaction = { emoji: string; count: number; me: boolean }

/** The reactions a `reactionsJson` column holds (none for `null`), or `null` when the text is not shaped as `reactionsJson` writes it. */
export function storedReactions(json: string | null): StoredReaction[] | null {
  if (json === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const reactions: StoredReaction[] = []
  for (const entry of parsed) {
    const emoji = textOrNull(fieldOf(entry, "emoji"))
    const count = intOrNull(fieldOf(entry, "count"))
    const me = fieldOf(entry, "me")
    if (emoji === null || count === null || typeof me !== "boolean") return null
    reactions.push({ emoji, count, me })
  }
  return reactions
}
