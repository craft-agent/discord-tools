import { ingestChannels, ingestHistoryPage } from "../discord/ingest"
import { markCurrent, setCursorEdges } from "../discord/mirror-cursors"
import { CHANNEL, channelObject, messageObject, msgId, SERVER } from "../discord/objects.testing"
import type { JsonRecord } from "../discord/ingest-values"
import type { ChatFixture } from "./read.testing"

/** A forum and a category of the made-up server, which hold no messages. */
export const FORUM = "1400000000000000210"
export const CATEGORY = "1400000000000000211"

/** Stores the text channel `CHANNEL`, a forum and a category in the mirror, as a channel list would. */
export function seedChannels(f: ChatFixture): void {
  f.seed((m) =>
    ingestChannels(
      m,
      f.ingestContext(),
      [channelObject(CHANNEL), channelObject(FORUM, { type: 15 }), channelObject(CATEGORY, { type: 4 })],
      SERVER,
    ),
  )
}

/**
 * Stores the messages `msgId(n)` of the channel as a sync run would: one page
 * covering them, the cursor edges, and, when `current`, the mark that lets a
 * read serve the channel from the mirror.
 */
export function seedHistory(
  f: ChatFixture,
  numbers: number[],
  options: { current?: boolean; complete?: boolean; channel?: string } = {},
): void {
  const channel = options.channel ?? CHANNEL
  const sorted = [...numbers].sort((a, b) => a - b)
  const oldest = sorted[0]!
  const newest = sorted.at(-1)!
  f.seed((m) => {
    const page = sorted.map((n) => messageObject(msgId(n), channel))
    ingestHistoryPage(m, f.ingestContext(), channel, page, { after: msgId(oldest - 1), before: msgId(newest + 1) })
    setCursorEdges(m, channel, { newest: msgId(newest), oldest: msgId(oldest), complete: options.complete === true })
    if (options.current) markCurrent(m, channel, f.now())
  })
}

const idOf = (message: JsonRecord): bigint => BigInt(message.id as string)

/**
 * Makes the fake Discord answer the channel's history endpoint from `messages`
 * as Discord does: newest first, `before` and `after` exclusive, `after` giving
 * the oldest messages above it, `around` a window centred on the message.
 */
export function serveHistory(f: ChatFixture, messages: JsonRecord[], channel = CHANNEL): void {
  const oldestFirst = [...messages].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1))
  f.discord.route("GET", `/channels/${channel}/messages`, (request) => {
    const limit = Number(request.query.get("limit"))
    const before = request.query.get("before")
    const after = request.query.get("after")
    const around = request.query.get("around")
    let page: JsonRecord[]
    if (around !== null) {
      const at = oldestFirst.findIndex((message) => message.id === around)
      const start = Math.max(0, at - Math.floor(limit / 2))
      page = oldestFirst.slice(start, start + limit)
    } else if (after !== null) {
      page = oldestFirst.filter((message) => idOf(message) > BigInt(after)).slice(0, limit)
    } else {
      page = oldestFirst.filter((message) => before === null || idOf(message) < BigInt(before)).slice(-limit)
    }
    return { status: 200, json: page.reverse() }
  })
}

/** The requests for a channel's messages the fake Discord has received. */
export function historyRequests(f: ChatFixture, channel = CHANNEL) {
  return f.discord.api.filter((request) => request.path === `/channels/${channel}/messages`)
}

/** The ids of a result's messages. */
export const messageIds = (result: { messages?: { id: string }[] }) => result.messages?.map((message) => message.id)

/** `msgId` of each number. */
export const idsOf = (...numbers: number[]) => numbers.map(msgId)

/** The messages `msgId(n)` of the channel as Discord sends them. */
export const history = (...numbers: number[]) => numbers.map((n) => messageObject(msgId(n), CHANNEL))
