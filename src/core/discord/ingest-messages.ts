import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import { attachmentsJson, embedsJson, reactionsJson, stickersJson } from "./ingest-parts"
import { storeUser } from "./ingest-users"
import {
  fieldOf,
  flag,
  idOrNull,
  idText,
  idTexts,
  intOrNull,
  isRecord,
  jsonOrNull,
  listOf,
  textOrNull,
  timeOrNull,
  type JsonRecord,
} from "./ingest-values"
import type { Mirror } from "./mirror"
import { serverOfChannel, upsertMessage, type MessageRow } from "./mirror-rows"
import { snowflakeTime } from "./snowflake"

/** Message type of a reply. */
const REPLY_MESSAGE_TYPE = 19

/** `message_reference.type` of a forward. */
const FORWARD_REFERENCE_TYPE = 1

type Reference = Pick<MessageRow, "ref_kind" | "ref_message" | "ref_channel">

/** What a message points at: a forward (a reference of type 1, or snapshots), a reply (a reference with a message on a reply), or nothing. */
function referenceOf(message: JsonRecord): Reference {
  const reference = isRecord(message.message_reference) ? message.message_reference : null
  const target = { ref_message: idOrNull(reference?.message_id), ref_channel: idOrNull(reference?.channel_id) }
  if (reference?.type === FORWARD_REFERENCE_TYPE || listOf(message.message_snapshots).length > 0) {
    return { ref_kind: "forward", ...target }
  }
  if (target.ref_message !== null && message.type === REPLY_MESSAGE_TYPE) return { ref_kind: "reply", ...target }
  return { ref_kind: null, ref_message: null, ref_channel: null }
}

/** The row of a message, or `null` when it has no valid id or channel. `server` fills in when the message names none. */
function messageRow(
  message: unknown,
  ctx: IngestContext,
  reactions: boolean,
  serverOf: (channel: bigint) => bigint | null,
): MessageRow | null {
  if (!isRecord(message)) return null
  const idString = idText(message.id)
  const channel = idOrNull(message.channel_id)
  if (idString === null || channel === null) return null
  const id = BigInt(idString)
  const author = idText(fieldOf(message.author, "id"))
  return {
    id,
    channel,
    server: idOrNull(message.guild_id) ?? serverOf(channel),
    author: author === null ? null : BigInt(author),
    from_me: author !== null && author === ctx.me ? 1 : 0,
    type: intOrNull(message.type) ?? 0,
    content: typeof message.content === "string" ? message.content : "",
    author_nick: textOrNull(fieldOf(message.member, "nick")),
    ...referenceOf(message),
    mentions: jsonOrNull(listOf(message.mentions).flatMap((user) => idText(fieldOf(user, "id")) ?? [])),
    mention_roles: jsonOrNull(idTexts(message.mention_roles)),
    mention_everyone: flag(message.mention_everyone),
    attachments: attachmentsJson(message.attachments),
    embeds: embedsJson(message.embeds),
    stickers: stickersJson(message.sticker_items),
    reactions: reactions ? reactionsJson(message.reactions) : null,
    pinned: flag(message.pinned),
    flags: intOrNull(message.flags) ?? 0,
    created_at: snowflakeTime(idString),
    edited_at: timeOrNull(message.edited_timestamp),
    raw: JSON.stringify(message),
    updated: ctx.now,
  }
}

/** Counts of a message batch and the ids it stored. */
export type StoredMessages = { counts: IngestCounts; ids: Set<bigint> }

/** Stores messages and their authors and mentioned users; `reactions` says whether the batch is authoritative for reactions. */
export function storeMessages(
  mirror: Mirror,
  ctx: IngestContext,
  messages: unknown[],
  reactions: boolean,
): StoredMessages {
  const counts = newCounts()
  const ids = new Set<bigint>()
  const servers = new Map<bigint, bigint | null>()
  const serverOf = (channel: bigint) => {
    if (!servers.has(channel)) servers.set(channel, serverOfChannel(mirror, channel))
    return servers.get(channel) ?? null
  }
  for (const message of messages) {
    const row = messageRow(message, ctx, reactions, serverOf)
    if (!row) {
      counts.skipped += 1
      continue
    }
    storeUser(mirror, ctx, fieldOf(message, "author"))
    for (const user of listOf(fieldOf(message, "mentions"))) storeUser(mirror, ctx, user)
    upsertMessage(mirror, row, reactions)
    ids.add(row.id)
    counts.stored += 1
  }
  return { counts, ids }
}

/**
 * Stores messages, their authors and the users they mention. `reactions` is
 * true for a channel's history, which is authoritative for them; search, pin
 * and mention results pass false and leave stored reactions alone. A message
 * without a server keeps the one its stored channel has.
 */
export function ingestMessages(
  mirror: Mirror,
  ctx: IngestContext,
  messages: unknown[],
  options: { reactions: boolean },
): IngestCounts {
  return storeMessages(mirror, ctx, messages, options.reactions).counts
}
