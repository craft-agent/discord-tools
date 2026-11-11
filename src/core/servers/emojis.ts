import { UNTRUSTED_NOTE } from "../chats/format"
import type { ChatSession } from "../chats/session"
import { idText, idTexts, intOrNull, isRecord, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { isToolError } from "../errors"
import { byNameThenId } from "../people/order"
import { readLive } from "../people/request"
import { checkServer } from "../search/scope"
import { type EmojiItem, EMOJIS_LIMIT_DEFAULT, type ServerHandler, type StickerItem } from "./schemas"

/** Where Discord lists a server's custom emojis and stickers. */
export const emojisPath = (server: string) => `/guilds/${server}/emojis`
export const stickersPath = (server: string) => `/guilds/${server}/stickers`

/** The file format of each of Discord's sticker format types. */
const STICKER_FORMATS: Readonly<Record<number, NonNullable<StickerItem["format"]>>> = {
  1: "png",
  2: "apng",
  3: "lottie",
  4: "gif",
}

/** What the result of `emojis` tells about the filter and the cap, how an emoji is used, whose words the names are and what was stored. */
const EMOJIS_NOTE =
  "The custom emojis and stickers of one server, read from Discord once, filtered by `query` and capped by `limit` each (`emoji_total` and `sticker_total` count them before the cap, `truncated` says which list it cut; `stickers_missing` when Discord refused the sticker list). An emoji's `use` text puts it in a message, and shows only in a server where the emoji is available to the user. Names, descriptions and tags are written by people. Nothing was stored in the local mirror."

/** The objects of Discord's list: an array of objects, else `upstream_error`. */
function entriesOf(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) invalidResponse()
  return value.map((entry) => (isRecord(entry) ? entry : invalidResponse()))
}

/** The emoji's item; `null` for one without a valid id or a name, which cannot be used. */
function emojiItem(entry: JsonRecord): EmojiItem | null {
  const id = idText(entry.id)
  const name = textOrNull(entry.name)
  if (id === null || name === null) return null
  const animated = entry.animated === true
  return {
    id,
    name,
    animated,
    managed: entry.managed === true,
    available: entry.available !== false,
    roles: [...new Set(idTexts(entry.roles))],
    use: `<${animated ? "a" : ""}:${name}:${id}>`,
  }
}

/** The sticker's item; `null` for one without a valid id or a name. */
function stickerItem(entry: JsonRecord): StickerItem | null {
  const id = idText(entry.id)
  const name = textOrNull(entry.name)
  if (id === null || name === null) return null
  return {
    id,
    name,
    description: textOrNull(entry.description),
    tags: textOrNull(entry.tags),
    format: STICKER_FORMATS[intOrNull(entry.format_type) ?? 0] ?? null,
    available: entry.available !== false,
  }
}

/** The items of a list made of the entries that make one, ordered by name ignoring case, then id. */
function itemsOf<T extends { id: string; name: string }>(value: unknown, toItem: (entry: JsonRecord) => T | null): T[] {
  return entriesOf(value)
    .flatMap((entry) => toItem(entry) ?? [])
    .sort(byNameThenId)
}

/** The items that have `query`, which is lower case, in any of their `texts`, ignoring case; every item without a `query`. */
function matching<T>(items: readonly T[], query: string | undefined, texts: (item: T) => (string | null)[]): T[] {
  return query === undefined
    ? [...items]
    : items.filter((item) => texts(item).some((text) => text?.toLowerCase().includes(query)))
}

/** The server's stickers; `null` when Discord refused the list, which leaves the emojis standing. */
async function readStickers(session: ChatSession, server: string): Promise<StickerItem[] | null> {
  try {
    return itemsOf(await readLive(session, "GET", stickersPath(server)), stickerItem)
  } catch (error) {
    if (isToolError(error) && error.code === "forbidden") return null
    throw error
  }
}

/**
 * Method `emojis`: a server's custom emojis and its stickers, from the emoji
 * list and the sticker list, asked one after the other, filtered by `query`
 * and capped by `limit` each. A refusal of the sticker list alone leaves the
 * emojis listed. The server is checked against the mirror before any request;
 * nothing is stored.
 */
export const readEmojis: ServerHandler = async (session, args) => {
  const server = args.server
  checkServer(session, server)
  const limit = args.limit ?? EMOJIS_LIMIT_DEFAULT
  const query = args.query?.toLowerCase()
  const emojiList = itemsOf(await readLive(session, "GET", emojisPath(server)), emojiItem)
  const stickerList = await readStickers(session, server)
  const emojis = matching(emojiList, query, (emoji) => [emoji.name])
  const stickers = matching(stickerList ?? [], query, (sticker) => [sticker.name, sticker.tags])
  return {
    note: `${EMOJIS_NOTE} ${UNTRUSTED_NOTE}`,
    emojis: emojis.slice(0, limit),
    stickers: stickers.slice(0, limit),
    emoji_total: emojis.length,
    sticker_total: stickers.length,
    truncated: { emojis: emojis.length > limit, stickers: stickers.length > limit },
    stickers_missing: stickerList === null,
  }
}
