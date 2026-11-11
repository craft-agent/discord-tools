import { mirroredChannelId } from "../chats/channel-target"
import { displayName, idTime, UNTRUSTED_NOTE } from "../chats/format"
import { WRITTEN_TYPES } from "../chats/message-items"
import type { ChatSession } from "../chats/session"
import { getCursor, isChannelCurrent } from "../discord/mirror-cursors"
import { placesOf } from "../inbox/places"
import { checkServer } from "../search/scope"
import { COUNTS_LIMIT_DEFAULT, DAYS_LIMIT_DEFAULT, windowOf } from "./args"
import { localDays, QUARTER_HOUR_MS, type QuarterHourCount, zoneOf } from "./days"
import type { AuthorCount, ChatCount, CountGroup, HistoryHandler, HistoryPayload, HistoryReadInput } from "./schemas"

/** What the result of `counts` says about what it counts, where it comes from and what it cannot know. */
const COUNTS_NOTE =
  "These counts were read from the local mirror alone; no request was made to Discord. Only ordinary messages and replies are counted, never system messages, and no text is read. A chat is `partial` when the mirror's history of it does not reach back to the window's start, or the mirror holds only scraps of it (search results, mentions), and not `current` when no sync run marked it in the last 15 minutes. When `coverage.partial` or `coverage.not_current` is above 0, the counts are lower bounds: a backfill (`discord_chat_read` method `backfill`, for a chat the sync follows) or the next sync run fills them in. Days are cut at midnight in `time_zone`."

/** The messages the window counts, as the query selects them: the `FROM` and `WHERE` clauses and their parameters. */
type Selection = { from: string; params: (bigint | number)[] }

/** A chat with counted messages, as the mirror's query groups them. */
type ChatGroup = {
  channel: string
  server: string | null
  messages: number
  from_me: number
  people: number
  first: string
  last: string
}

/** An author with counted messages, as the mirror's query groups them. */
type AuthorGroup = { author_id: string; messages: number; chats: number; last: string }

/** The columns that name an author, of their latest counted message. */
type AuthorNameRow = Parameters<typeof displayName>[0] & { author_nick: string | null }

/** Whether the mirror's history of a chat falls short of the window, and whether a sync run vouched for it lately. */
type Coverage = Pick<ChatCount, "partial" | "current">

/** A chat with counted messages and its coverage. */
type CoveredGroup = Coverage & { group: ChatGroup }

/**
 * The messages to count: ordinary messages and replies after `after` and
 * before `before` (both exclusive), in the server and the chat the arguments
 * name. The query joins `channels` as `c`, so a message with no server of its
 * own takes its channel's.
 */
function selectionOf(window: ReturnType<typeof windowOf>, scope: Pick<HistoryReadInput, "server" | "chat">): Selection {
  const clauses = [`m.type IN (${WRITTEN_TYPES.join(", ")})`, "m.id > ?"]
  const params: Selection["params"] = [BigInt(window.after)]
  if (window.before !== undefined) {
    clauses.push("m.id < ?")
    params.push(BigInt(window.before))
  }
  if (scope.server !== undefined) {
    clauses.push("COALESCE(m.server, c.server) = ?")
    params.push(BigInt(scope.server))
  }
  if (scope.chat !== undefined) {
    clauses.push("m.channel = ?")
    params.push(BigInt(scope.chat))
  }
  return { from: `FROM messages m LEFT JOIN channels c ON c.id = m.channel WHERE ${clauses.join(" AND ")}`, params }
}

/** Every chat with counted messages, the one with the most first, then the most recent. */
function chatGroups(session: ChatSession, selection: Selection): ChatGroup[] {
  return session.mirror
    .prepare(
      `SELECT CAST(m.channel AS TEXT) AS channel, CAST(MAX(COALESCE(m.server, c.server)) AS TEXT) AS server,
              COUNT(*) AS messages, SUM(m.from_me) AS from_me, COUNT(DISTINCT m.author) AS people,
              CAST(MIN(m.id) AS TEXT) AS first, CAST(MAX(m.id) AS TEXT) AS last
       ${selection.from} GROUP BY m.channel ORDER BY messages DESC, MAX(m.id) DESC`,
    )
    .all(...selection.params) as ChatGroup[]
}

/** How many different authors wrote the counted messages; a message with no author is not a person. */
function peopleOf(session: ChatSession, selection: Selection): number {
  const row = session.mirror
    .prepare(`SELECT COUNT(DISTINCT m.author) AS people ${selection.from}`)
    .get(...selection.params) as { people: number }
  return row.people
}

/**
 * Whether the mirror's history of `channel` falls short of the window that
 * starts after `after`: the chat has no cursor (the mirror holds only scraps
 * of it) or one with no oldest edge, or its history is incomplete and its
 * oldest vouched message is newer than `after`. And whether a sync run marked
 * it current lately.
 */
function coverageOf(session: ChatSession, channel: string, after: string): Coverage {
  const cursor = getCursor(session.mirror, channel)
  const partial =
    cursor === undefined || cursor.oldest === null || (!cursor.complete && BigInt(cursor.oldest) > BigInt(after))
  return { partial, current: isChannelCurrent(session.mirror, channel, session.now()) }
}

/** The rows of `by` `chat`: each chat named as people see it, with its coverage. */
function chatRows(session: ChatSession, covered: CoveredGroup[]): ChatCount[] {
  const places = placesOf(session.mirror)
  return covered.map(({ group, partial, current }) => ({
    chat: {
      id: group.channel,
      name: places.chat(group.channel),
      kind: places.kind(group.channel),
      server: group.server,
      server_name: places.server(group.server),
    },
    messages: group.messages,
    from_me: group.from_me,
    people: group.people,
    first: idTime(group.first),
    last: idTime(group.last),
    partial,
    current,
  }))
}

/**
 * The authors with the most counted messages first, then the most recent, at
 * most `limit + 1` of them so the caller can tell whether `limit` cut the list.
 * An author is named by the server nickname of their latest counted message,
 * else by their display name, else not at all.
 */
function authorRows(session: ChatSession, selection: Selection, limit: number): AuthorCount[] {
  const groups = session.mirror
    .prepare(
      `SELECT CAST(m.author AS TEXT) AS author_id, COUNT(*) AS messages, COUNT(DISTINCT m.channel) AS chats,
              CAST(MAX(m.id) AS TEXT) AS last
       ${selection.from} AND m.author IS NOT NULL
       GROUP BY m.author ORDER BY messages DESC, MAX(m.id) DESC LIMIT ?`,
    )
    .all(...selection.params, limit + 1) as AuthorGroup[]
  const nameOf = session.mirror.prepare(
    `SELECT m.author_nick, u.username, u.global_name
     FROM messages m LEFT JOIN users u ON u.id = m.author WHERE m.id = ?`,
  )
  return groups.map((group) => {
    const row = nameOf.get(BigInt(group.last)) as AuthorNameRow | undefined
    return {
      author_id: group.author_id,
      author: row ? (row.author_nick ?? displayName(row)) : null,
      messages: group.messages,
      chats: group.chats,
      last: idTime(group.last),
    }
  })
}

/** The counted messages per quarter hour; `localDays` gives them their days. */
function quarterHours(session: ChatSession, selection: Selection): QuarterHourCount[] {
  return session.mirror
    .prepare(
      `SELECT m.created_at / ${QUARTER_HOUR_MS} AS bucket, COUNT(*) AS messages, SUM(m.from_me) AS from_me
       ${selection.from} GROUP BY bucket`,
    )
    .all(...selection.params) as QuarterHourCount[]
}

/** The rows of one `by`: its own array in the result, and whether `limit` cut it. */
type Rows = Pick<HistoryPayload, "more" | "by_chat" | "by_author" | "by_day">

/**
 * Method `counts`: the ordinary messages and replies the mirror holds in a
 * window (the past 30 days by default), per chat, per author or per day, from
 * the mirror alone; no request is made and no text is read. The totals cover
 * the whole window and `coverage` every chat with counted messages, however
 * `limit` cuts the rows. A chat the mirror holds only scraps of, or whose
 * history does not reach back to the window's start, is partial; one no sync
 * run marked lately is not current: both make a count a lower bound.
 */
export const readCounts: HistoryHandler = async (session, args) => {
  const by: CountGroup = args.by ?? "chat"
  const limit = args.limit ?? (by === "day" ? DAYS_LIMIT_DEFAULT : COUNTS_LIMIT_DEFAULT)
  if (args.server !== undefined) checkServer(session, args.server)
  if (args.chat !== undefined) mirroredChannelId(session, args.chat)
  const zone = zoneOf(args.time_zone)
  const window = windowOf(args, session.now())
  const selection = selectionOf(window, args)

  const groups = chatGroups(session, selection)
  const total = groups.reduce((sum, group) => sum + group.messages, 0)
  const fromMe = groups.reduce((sum, group) => sum + group.from_me, 0)
  const covered = groups.map((group): CoveredGroup => ({ group, ...coverageOf(session, group.channel, window.after) }))

  const rows: Rows = { more: false }
  if (by === "chat") {
    rows.by_chat = chatRows(session, covered.slice(0, limit))
    rows.more = groups.length > limit
  } else if (by === "author") {
    const authors = authorRows(session, selection, limit)
    rows.by_author = authors.slice(0, limit)
    rows.more = authors.length > limit
  } else {
    const days = localDays(quarterHours(session, selection), zone)
    rows.by_day = days.slice(-limit)
    rows.more = days.length > limit
  }

  return {
    source: "mirror",
    note: `${COUNTS_NOTE} ${UNTRUSTED_NOTE}`,
    by,
    window_start: idTime(String(BigInt(window.after) + 1n)),
    window_end: window.before === undefined ? null : idTime(window.before),
    time_zone: zone,
    total,
    from_me: fromMe,
    from_others: total - fromMe,
    people: peopleOf(session, selection),
    chats: groups.length,
    coverage: {
      partial: covered.filter(({ partial }) => partial).length,
      not_current: covered.filter(({ current }) => !current).length,
    },
    ...rows,
  }
}
