import { ToolError } from "../errors"
import { CATEGORY_TYPE } from "../chats/channels"
import { mirroredChannelId } from "../chats/channel-target"
import { parseBounds } from "../chats/bounds"
import { channelKind, UNTRUSTED_NOTE } from "../chats/format"
import { reactionsNote } from "../chats/message-items"
import type { ChatSession } from "../chats/session"
import { SEARCH_LIMIT_DEFAULT } from "./args"
import { itemsOf, SEARCH_ROWS_SELECT, type SearchRow } from "./items"
import type { SearchHandler, SearchHas, SearchReadInput } from "./schemas"
import { checkServer } from "./scope"

/** What the result of a search of the mirror tells about its reach and its text matching. */
const MIRROR_NOTE =
  "This searched only what the local mirror holds, current or not: `chats` says when a sync run last marked each chat current. `query` was matched as a literal substring, ignoring case for A–Z only."

/** Tells SQLite's `LIKE` that a backslash escapes the wildcard after it. */
const LIKE_ESCAPE = "ESCAPE '\\'"

/** A character that follows an emoji to ask for its picture form; Discord's names carry it for some emoji and a person's may not. */
const EMOJI_VARIATION_SELECTOR = 0xfe0f

/** A custom emoji as the message text writes it, `<:name:id>` or `<a:name:id>`; the groups are the name and the id. */
const CUSTOM_EMOJI_PATTERN = /^<a?:(\w+):(\d{1,20})>$/

/** The prefix of the MIME type of the attachments each `has` value stands for. */
const ATTACHMENT_TYPE_PREFIX = { image: "image/", video: "video/", sound: "audio/" } as const

/** The value types SQLite is given. */
type Param = string | bigint | number

/** The conditions of one search, joined with AND, and the values their `?` stand for in order. */
type Conditions = { sql: string[]; params: Param[] }

/** `text` as a `LIKE` pattern that finds it anywhere, with its backslashes and wildcards taken literally. */
function likeContaining(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`
}

/** `text` without the character that asks for an emoji's picture form. */
function withoutVariation(text: string): string {
  return text.replaceAll(String.fromCharCode(EMOJI_VARIATION_SELECTOR), "")
}

/** The key a reaction's emoji is stored under (`name:id` for a custom one), whichever way `emoji` writes it. */
function reactionKey(emoji: string): string {
  const custom = CUSTOM_EMOJI_PATTERN.exec(emoji)
  return withoutVariation(custom ? `${custom[1]}:${custom[2]}` : emoji)
}

/** SQL that is true when some element `e` of the JSON list in `column` satisfies `test`; false when the column is empty or not JSON. */
function someElement(column: string, test: string): string {
  return `CASE WHEN json_valid(${column}) THEN EXISTS (SELECT 1 FROM json_each(${column}) AS e WHERE ${test}) ELSE 0 END`
}

/** The condition on a message that has the property `has` names, with its values. */
function hasCondition(has: SearchHas): { sql: string; params: Param[] } {
  switch (has) {
    case "link":
      return { sql: "(m.content LIKE '%http://%' OR m.content LIKE '%https://%')", params: [] }
    case "file":
      return { sql: someElement("m.attachments", "1"), params: [] }
    case "embed":
      return { sql: someElement("m.embeds", "1"), params: [] }
    case "sticker":
      return { sql: someElement("m.stickers", "1"), params: [] }
    case "poll":
      return { sql: "json_extract(m.raw, '$.poll') IS NOT NULL", params: [] }
    case "image":
    case "video":
    case "sound":
      return {
        sql: someElement(
          "m.attachments",
          "CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.type') LIKE ? ELSE 0 END",
        ),
        params: [`${ATTACHMENT_TYPE_PREFIX[has]}%`],
      }
  }
}

/** The channel a search may look in, as the mirror knows it; a category, and a forum or media channel without `threads`, hold no messages of their own. */
function checkChannel(session: ChatSession, channel: string, threads: boolean): void {
  const { type } = mirroredChannelId(session, channel)
  const kind = channelKind(type)
  if (type === CATEGORY_TYPE) {
    throw new ToolError(
      "invalid_argument",
      `Channel ${channel} is a category and holds no messages: search a channel under it, or its server.`,
    )
  }
  if ((kind === "forum" || kind === "media") && !threads) {
    throw new ToolError(
      "invalid_argument",
      `Channel ${channel} is a ${kind} channel and holds no messages of its own: pass threads true to search its posts.`,
    )
  }
}

/** The conditions the arguments describe, over `messages m LEFT JOIN channels c ON c.id = m.channel`. */
function conditionsOf(session: ChatSession, args: SearchReadInput): Conditions {
  const conditions: Conditions = { sql: [], params: [] }
  const add = (sql: string, ...params: Param[]) => {
    conditions.sql.push(sql)
    conditions.params.push(...params)
  }
  if (args.channel !== undefined) {
    checkChannel(session, args.channel, args.threads === true)
    const channel = BigInt(args.channel)
    // A subquery of chats keeps the lookup on the messages' channel index.
    if (args.threads === true)
      add("m.channel IN (SELECT id FROM channels WHERE id = ? OR parent = ?)", channel, channel)
    else add("m.channel = ?", channel)
  }
  if (args.server !== undefined) {
    checkServer(session, args.server)
    const server = BigInt(args.server)
    add(
      "(m.server = ? OR (m.server IS NULL AND m.channel IN (SELECT id FROM channels WHERE server = ?)))",
      server,
      server,
    )
  }
  if (args.query !== undefined) add(`m.content LIKE ? ${LIKE_ESCAPE}`, likeContaining(args.query))
  if (args.author !== undefined) add("m.author = ?", BigInt(args.author))
  if (args.mentions !== undefined) add(someElement("m.mentions", "e.value = ?"), args.mentions)
  for (const has of args.has ?? []) {
    const { sql, params } = hasCondition(has)
    add(sql, ...params)
  }
  if (args.pinned !== undefined) add("m.pinned = ?", args.pinned ? 1 : 0)
  if (args.reacted !== undefined) {
    const own = someElement(
      "m.reactions",
      "CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.me') = 1 ELSE 0 END",
    )
    add(args.reacted ? own : `NOT (${own})`)
  }
  if (args.emoji !== undefined) {
    const stored = `replace(json_extract(e.value, '$.emoji'), char(${EMOJI_VARIATION_SELECTOR}), '')`
    add(
      someElement("m.reactions", `CASE WHEN e.type = 'object' THEN ${stored} = ? ELSE 0 END`),
      reactionKey(args.emoji),
    )
  }
  const { before, after } = parseBounds(args.before, args.after)
  if (before !== undefined) add("m.id < ?", BigInt(before))
  if (after !== undefined) add("m.id > ?", BigInt(after))
  return conditions
}

/**
 * Method `mirror`: the newest messages the local mirror holds that match every
 * condition, whether or not their chat is current, and the chats they are in.
 * Makes no request. The page is full exactly when more may follow, since the
 * mirror is searched in full.
 */
export const searchMirror: SearchHandler = async (session, args) => {
  const { sql, params } = conditionsOf(session, args)
  const limit = args.limit ?? SEARCH_LIMIT_DEFAULT
  const rows = session.mirror
    .prepare(`${SEARCH_ROWS_SELECT} WHERE ${sql.join(" AND ")} ORDER BY m.id DESC LIMIT ?`)
    .all(...params, limit) as SearchRow[]
  const { messages, chats } = itemsOf(session, rows)
  const oldest = messages.at(-1)
  return {
    source: "mirror",
    note: `${MIRROR_NOTE} ${UNTRUSTED_NOTE}`,
    messages,
    chats,
    ...(oldest && messages.length === limit ? { next_before: oldest.id } : {}),
    ...reactionsNote(messages),
  }
}
