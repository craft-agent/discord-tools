import { fieldOf, idText, intOrNull, listOf, textOrNull, type JsonRecord } from "../discord/ingest-values"
import type { FileKind } from "./schemas"

/** One thing a message carries that can be saved. */
export type SaveItem = {
  kind: FileKind
  /** The name Discord gives it, before it is cleaned. */
  name: string
  url: string
  /** The media type Discord declared, for an attachment. */
  type?: string
  /** The size in bytes Discord declared, for an attachment. */
  size?: number
  /** The link a preview belongs to. */
  previewOf?: string
}

/** The parts of an embed whose image is saved. */
const EMBED_PARTS = ["image", "thumbnail", "video"] as const

/** The sticker formats Discord has, by `format_type`, with the file each is saved as and the host it comes from. */
const STICKER_FORMATS: Readonly<Record<number, { extension: string; host: string }>> = {
  1: { extension: "png", host: "cdn.discordapp.com" },
  2: { extension: "png", host: "cdn.discordapp.com" },
  3: { extension: "json", host: "cdn.discordapp.com" },
  4: { extension: "gif", host: "media.discordapp.net" },
}

/** The last segment of a URL's path, decoded; undefined when there is none. */
function lastSegment(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined
  const segment = new URL(url).pathname.split("/").at(-1)
  if (!segment) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * What a message carries, one item per URL and in the order they are saved:
 * its attachments, the `proxy_url` of each embed's image, thumbnail and video
 * (never the `url` that leads to the site behind a link), then its stickers.
 * A name Discord gives none is `file-<n>`, `n` being the item's place in the
 * list, or `preview-<part>`; a sticker without a name is named by its id, and
 * one of a format that has no file is left out.
 */
export function collectItems(message: JsonRecord): SaveItem[] {
  const items: SaveItem[] = []
  const seen = new Set<string>()
  const add = (item: SaveItem): void => {
    if (seen.has(item.url)) return
    seen.add(item.url)
    items.push(item)
  }

  for (const attachment of listOf(message.attachments)) {
    const url = textOrNull(fieldOf(attachment, "url"))
    if (url === null) continue
    const type = textOrNull(fieldOf(attachment, "content_type"))
    const size = intOrNull(fieldOf(attachment, "size"))
    add({
      kind: "attachment",
      name: textOrNull(fieldOf(attachment, "filename")) ?? `file-${items.length + 1}`,
      url,
      ...(type === null ? {} : { type }),
      ...(size === null || size < 0 ? {} : { size }),
    })
  }

  for (const embed of listOf(message.embeds)) {
    const previewOf = textOrNull(fieldOf(embed, "url"))
    for (const part of EMBED_PARTS) {
      const url = textOrNull(fieldOf(fieldOf(embed, part), "proxy_url"))
      if (url === null) continue
      const base = lastSegment(url)
      add({
        kind: "preview",
        name: base === undefined ? `preview-${part}` : `preview-${base}`,
        url,
        ...(previewOf === null ? {} : { previewOf }),
      })
    }
  }

  for (const sticker of listOf(message.sticker_items)) {
    const id = idText(fieldOf(sticker, "id"))
    const format = STICKER_FORMATS[intOrNull(fieldOf(sticker, "format_type")) ?? 0]
    if (id === null || format === undefined) continue
    add({
      kind: "sticker",
      name: `${textOrNull(fieldOf(sticker, "name")) ?? id}.${format.extension}`,
      url: `https://${format.host}/stickers/${id}.${format.extension}`,
    })
  }
  return items
}
