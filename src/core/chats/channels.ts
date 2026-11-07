import { ToolError } from "../errors"
import { ingestChannels } from "../discord/ingest"
import { idText, intOrNull, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { isChannelCurrent } from "../discord/mirror-cursors"
import { readSyncList } from "../discord/sync-list"
import { channelRecords } from "../discord/sync-page"
import { pickServerChannels } from "../discord/sync-selection"
import { requireServer } from "./args"
import { channelKind, idTime } from "./format"
import type { ChannelItem } from "./schemas"
import type { ChatHandler, ChatSession } from "./session"

/** The channel type of a category, which names the channels under it but is no channel to read. */
export const CATEGORY_TYPE = 4

/** The channel types of threads, which are read through their parent. */
const THREAD_TYPES: readonly number[] = [10, 11, 12]

/** Sorts a channel or a category without a position after those that have one. */
const LAST_POSITION = Number.MAX_SAFE_INTEGER

/** Sorts channels outside any category before the categories, as Discord's own list does. */
const NO_CATEGORY_POSITION = -1

type Placed = { item: ChannelItem; categoryPosition: number; categoryId: bigint }

/** Orders by category position, category, channel position and id. */
function compare(a: Placed, b: Placed): number {
  const keys: [number | bigint, number | bigint][] = [
    [a.categoryPosition, b.categoryPosition],
    [a.categoryId, b.categoryId],
    [a.item.position ?? LAST_POSITION, b.item.position ?? LAST_POSITION],
    [BigInt(a.item.id), BigInt(b.item.id)],
  ]
  for (const [left, right] of keys) if (left !== right) return left < right ? -1 : 1
  return 0
}

function place(
  session: ChatSession,
  row: JsonRecord,
  categories: Map<string, JsonRecord>,
  followed: ReadonlySet<string>,
): Placed {
  const id = row.id as string
  const type = row.type as number
  const categoryId = idText(row.parent_id)
  const category = categoryId === null ? undefined : categories.get(categoryId)
  const lastMessage = idText(row.last_message_id)
  return {
    categoryPosition: intOrNull(category?.position) ?? (categoryId === null ? NO_CATEGORY_POSITION : LAST_POSITION),
    categoryId: BigInt(categoryId ?? 0),
    item: {
      id,
      name: textOrNull(row.name),
      kind: channelKind(type),
      type,
      category_id: categoryId,
      category: textOrNull(category?.name),
      position: intOrNull(row.position),
      last_message_at: lastMessage === null ? null : idTime(lastMessage),
      followed: followed.has(id),
      current: isChannelCurrent(session.mirror, id, session.now()),
    },
  }
}

/** Method `channels`: the channels of a server the mirror knows, read from Discord and stored. */
export const readChannels: ChatHandler = async (session, args) => {
  const server = requireServer(args)
  if (!session.mirror.prepare("SELECT 1 FROM servers WHERE id = ?").get(BigInt(server))) {
    throw new ToolError(
      "not_found",
      `This account has no server ${server} in its mirror: list servers with method servers first.`,
    )
  }
  const rows = channelRecords(
    await session.client().read("GET", `/guilds/${server}/channels`, {
      referer: `/channels/${server}`,
      ...(session.signal ? { signal: session.signal } : {}),
    }),
    server,
  )
  session.store((ctx) => ingestChannels(session.mirror, ctx, rows, server))

  const entry = (await readSyncList(session.paths)).servers.find((candidate) => candidate.id === server)
  const followed = new Set(entry ? pickServerChannels(rows, entry).map((row) => row.id as string) : [])
  const categories = new Map(rows.filter((row) => row.type === CATEGORY_TYPE).map((row) => [row.id as string, row]))
  const channels = rows
    .filter((row) => row.type !== CATEGORY_TYPE && !THREAD_TYPES.includes(row.type as number))
    .map((row) => place(session, row, categories, followed))
    .sort(compare)
    .map((placed) => placed.item)
  return { source: "live", channels }
}
