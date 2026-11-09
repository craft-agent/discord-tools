import { isAbsolute } from "node:path"
import { ToolError } from "../errors"
import { pickLabel } from "../discord/labels"
import { openMirrorForRead, type Mirror } from "../discord/mirror"
import type { CallFact, ToolContext } from "../tool"
import type { Translations } from "../words"
import { DM_TYPE, GROUP_DM_TYPE, recipientIds, userLookup } from "./dms"
import { clip, displayName } from "./format"
import { checkAbort } from "./session"

/** How many characters of a message a fact quotes. */
export const QUOTE_LENGTH = 80

/** The three kinds of thread, which a description names by their own name. */
const THREAD_KINDS: Readonly<Record<number, string>> = { 10: "Thread", 11: "Thread", 12: "Private thread" }

/** What a channel type is called in the `Chat` fact. */
const CHAT_KINDS: Readonly<Record<number, string>> = {
  0: "Text channel",
  1: "Direct message",
  2: "Voice channel",
  3: "Group DM",
  5: "Announcement channel",
  13: "Stage channel",
  ...THREAD_KINDS,
}
const OTHER_KIND = "Channel"

type ChannelRow = {
  server: string | null
  type: number
  name: string | null
  parent: string | null
  recipients: string | null
}
type NameRow = { name: string | null }
type MessageRow = {
  content: string
  from_me: number
  author_nick: string | null
  global_name: string | null
  username: string | null
}

/** A chat as an approval prompt names it: its name, and the facts that place it. */
export type DescribedChat = { name: string; facts: CallFact[] }

/** A mirrored message as an approval prompt shows it; `author` is `null` when the mirror has no name for it. */
export type MirroredMessage = { author: string | null; content: string; fromMe: boolean }

/**
 * Reads the label's mirror on a connection that writes nothing and closes it
 * after `read`. It never opens a Discord client, so describing a call sends no
 * request.
 */
export async function withMirror<T>(
  account: string | undefined,
  ctx: ToolContext,
  read: (mirror: Mirror) => T,
): Promise<T> {
  checkAbort(ctx.signal)
  const { stateDir } = ctx
  if (!stateDir || !isAbsolute(stateDir)) {
    throw new ToolError("internal_error", "Describing a call requires an absolute state directory.")
  }
  const paths = await pickLabel(stateDir, account)
  checkAbort(ctx.signal)
  const mirror = openMirrorForRead(paths.mirror)
  try {
    return read(mirror)
  } finally {
    mirror.close()
  }
}

/** A server channel as `#name`, or its id when the mirror holds no name for it. */
export function channelName(mirror: Mirror, id: string): string {
  const row = mirror.prepare("SELECT name FROM channels WHERE id = ?").get(BigInt(id)) as NameRow | undefined
  return row?.name ? `#${row.name}` : id
}

/** A server's name, or its id when the mirror holds no name for it (a server the account has left). */
export function serverName(mirror: Mirror, id: string): string {
  const row = mirror.prepare("SELECT name FROM servers WHERE id = ?").get(BigInt(id)) as NameRow | undefined
  return row?.name || id
}

/** The name of a chat as people see it (see `describeChat`). */
function chatName(mirror: Mirror, id: string, row: ChannelRow): string {
  const user = userLookup(mirror)
  const members = recipientIds(row.recipients).flatMap((member) => displayName(user(member)) ?? [])
  if (row.type === DM_TYPE) return members[0] ?? id
  if (row.type === GROUP_DM_TYPE) return row.name || members.join(", ") || id
  if (row.type in THREAD_KINDS) return row.name || id
  return row.name ? `#${row.name}` : id
}

/**
 * The name and the facts of a chat from the mirror: a server channel is
 * `#name`, a thread its name, a DM the other person's display name and a group
 * DM its name or its members'; one without a name is its id. `not_found` when
 * the mirror has no such channel.
 */
export function describeChat(mirror: Mirror, channel: string): DescribedChat {
  const row = mirror
    .prepare(
      `SELECT CAST(server AS TEXT) AS server, type, name, CAST(parent AS TEXT) AS parent, recipients
       FROM channels WHERE id = ?`,
    )
    .get(BigInt(channel)) as ChannelRow | undefined
  if (!row) {
    throw new ToolError("not_found", `The mirror holds no channel ${channel}.`)
  }
  const facts: CallFact[] = [{ label: "Chat", value: { text: CHAT_KINDS[row.type] ?? OTHER_KIND } }]
  if (row.server !== null) facts.push({ label: "Server", value: serverName(mirror, row.server) })
  if (row.type in THREAD_KINDS && row.parent !== null) {
    facts.push({ label: "Channel", value: channelName(mirror, row.parent) })
  }
  return { name: chatName(mirror, channel, row), facts }
}

/** A message text on one line, cut to `QUOTE_LENGTH`, so a fact keeps to the head of the prompt. */
export function quote(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), QUOTE_LENGTH)
}

/** The message `message` of `channel` as the mirror holds it, else `undefined`. */
export function mirroredMessage(mirror: Mirror, channel: string, message: string): MirroredMessage | undefined {
  const row = mirror
    .prepare(
      `SELECT m.content, m.from_me, m.author_nick, u.global_name, u.username
       FROM messages m LEFT JOIN users u ON u.id = m.author
       WHERE m.id = ? AND m.channel = ?`,
    )
    .get(BigInt(message), BigInt(channel)) as MessageRow | undefined
  if (!row) return undefined
  return {
    author: row.author_nick ?? row.global_name ?? row.username,
    content: row.content,
    fromMe: row.from_me === 1,
  }
}

/** The translations of the labels and the kinds of chat `describeChat` writes. */
export const CHAT_TRANSLATIONS: Translations = {
  ja: {
    Chat: "チャット",
    Server: "サーバー",
    Channel: "チャンネル",
    "Text channel": "テキストチャンネル",
    "Direct message": "ダイレクトメッセージ",
    "Voice channel": "ボイスチャンネル",
    "Group DM": "グループ DM",
    "Announcement channel": "アナウンスチャンネル",
    Thread: "スレッド",
    "Private thread": "プライベートスレッド",
    "Stage channel": "ステージチャンネル",
  },
}
