import type { Mirror } from "./mirror"

/** A value SQLite binds: ids are BigInt, so they stay exact above 2^53. */
type SqlValue = string | number | bigint | null

/** One `servers` row. */
export type ServerRow = {
  id: bigint
  name: string | null
  owner: 0 | 1 | null
  icon: string | null
  raw: string
  updated: number
}

/** One `channels` row; `recipients`, `thread` and `forum` hold JSON text. */
export type ChannelRow = {
  id: bigint
  server: bigint | null
  type: number
  name: string | null
  parent: bigint | null
  position: number | null
  last_message: bigint | null
  recipients: string | null
  thread: string | null
  forum: string | null
  raw: string
  updated: number
}

/** One `users` row. */
export type UserRow = {
  id: bigint
  username: string | null
  global_name: string | null
  bot: 0 | 1
  raw: string
  updated: number
}

/** One `messages` row; the JSON columns hold JSON text. */
export type MessageRow = {
  id: bigint
  channel: bigint
  server: bigint | null
  author: bigint | null
  from_me: 0 | 1
  type: number
  content: string
  author_nick: string | null
  ref_kind: "reply" | "forward" | null
  ref_message: bigint | null
  ref_channel: bigint | null
  mentions: string | null
  mention_roles: string | null
  mention_everyone: 0 | 1
  attachments: string | null
  embeds: string | null
  stickers: string | null
  reactions: string | null
  pinned: 0 | 1
  flags: number
  created_at: number
  edited_at: number | null
  raw: string
  updated: number
}

type UpsertOptions = {
  /** Columns that keep their stored value when the new row has none. */
  coalesce?: readonly string[]
  /** Columns that keep their stored value whatever the new row holds. */
  keep?: readonly string[]
}

/**
 * Inserts `row` into `table`, or on a conflict of `id` replaces every column
 * but those `options` say to keep. Names come from code, never from input.
 */
function upsert(mirror: Mirror, table: string, row: Record<string, SqlValue>, options: UpsertOptions = {}): void {
  const columns = Object.keys(row)
  const assignments = columns
    .filter((column) => column !== "id" && !options.keep?.includes(column))
    .map((column) =>
      options.coalesce?.includes(column)
        ? `${column} = COALESCE(excluded.${column}, ${table}.${column})`
        : `${column} = excluded.${column}`,
    )
  const placeholders = columns.map(() => "?").join(", ")
  mirror
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${assignments.join(", ")}`,
    )
    .run(...Object.values(row))
}

/** Inserts or replaces a server. A new row without `owner` keeps the stored one. */
export function upsertServer(mirror: Mirror, row: ServerRow): void {
  upsert(mirror, "servers", row, { coalesce: ["owner"] })
}

/** Inserts or replaces a channel. A new row without `recipients`, `last_message`, `thread` or `forum` keeps the stored one. */
export function upsertChannel(mirror: Mirror, row: ChannelRow): void {
  upsert(mirror, "channels", row, { coalesce: ["recipients", "last_message", "thread", "forum"] })
}

/** Inserts or replaces a user. */
export function upsertUser(mirror: Mirror, row: UserRow): void {
  upsert(mirror, "users", row)
}

/** Inserts or replaces a message; `reactionsKnown` false leaves the stored reactions alone. */
export function upsertMessage(mirror: Mirror, row: MessageRow, reactionsKnown: boolean): void {
  upsert(mirror, "messages", row, { keep: reactionsKnown ? [] : ["reactions"] })
}

/** The server a stored channel belongs to, or `null` when it has none or is not stored. */
export function serverOfChannel(mirror: Mirror, channel: bigint): bigint | null {
  const statement = mirror.prepare("SELECT server FROM channels WHERE id = ?")
  statement.setReadBigInts(true)
  const row = statement.get(channel) as Pick<ChannelRow, "server"> | undefined
  return row?.server ?? null
}

/** The ids of a channel's stored messages strictly between `after` and `before`. */
export function messageIdsBetween(mirror: Mirror, channel: bigint, after: bigint, before: bigint): bigint[] {
  const statement = mirror.prepare("SELECT id FROM messages WHERE channel = ? AND id > ? AND id < ?")
  statement.setReadBigInts(true)
  return (statement.all(channel, after, before) as Pick<MessageRow, "id">[]).map((row) => row.id)
}

/** Removes a message by id; returns how many rows went (0 or 1). */
export function deleteMessageRow(mirror: Mirror, id: bigint): number {
  return Number(mirror.prepare("DELETE FROM messages WHERE id = ?").run(id).changes)
}
