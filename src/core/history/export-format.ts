import { UNTRUSTED_NOTE } from "../chats/format"
import type { ExportMessage, ExportSelection } from "./export-select"
import { localTimeIn } from "./local-time"

/** The formats an export is written in. */
export const EXPORT_FORMATS = ["markdown", "json", "jsonl"] as const

/** One format an export is written in. */
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/** The extension of each format's file. */
const EXTENSIONS: Readonly<Record<ExportFormat, string>> = { markdown: "md", json: "json", jsonl: "jsonl" }

/** What is rendered besides the selection: the format, the zone times are written in, and when the export is made (ms). */
export type RenderOptions = { format: ExportFormat; time_zone: string; exportedAt: number }

/** What a file says about itself, for a reader who has only the file. */
const EXPORT_NOTE = `This file holds the history of the chat as the local mirror held it in one piece when it was made; no request was made to Discord. What it leaves out is counted in \`left_out\`. ${UNTRUSTED_NOTE}`

/** Every way a text can end a line: CRLF, LF, CR, VT, FF, NEL and the Unicode line and paragraph separators. */
const LINE_BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/

/** Controls and Unicode separators of lines, which a name or a single-line value folds into a space. */
const LINE_CONTROLS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

/** The separators JSON leaves unescaped but some line readers split on. */
const JSON_SEPARATORS = /[\u0085\u2028\u2029]/g

/** `value` as JSON, with the line separators JSON leaves bare written as escapes, so one line stays one line. */
function stringify(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    JSON_SEPARATORS,
    (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/** A name or any single-line value with its line breaks and control characters folded into spaces. */
function oneLine(text: string): string {
  return text.replace(LINE_CONTROLS, " ").trim()
}

/** Every line of `text` after `> `, an empty one as `>`: nothing in a text can start a heading of the file. */
function quote(text: string): string {
  return text
    .split(LINE_BREAKS)
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n")
}

/** The message with its times written in the zone of `local`. */
function localMessage(message: ExportMessage, local: (ms: number) => string): ExportMessage {
  return {
    ...message,
    at: local(Date.parse(message.at)),
    edited_at: message.edited_at === null ? null : local(Date.parse(message.edited_at)),
  }
}

/** The `export` object every format opens with: what the file is, and where it falls short of the chat. */
function exportMeta(
  selection: ExportSelection,
  options: RenderOptions,
  messages: readonly ExportMessage[],
  local: (ms: number) => string,
) {
  const first = messages[0]!
  const last = messages[messages.length - 1]!
  return {
    chat: selection.chat,
    format: options.format,
    time_zone: options.time_zone,
    exported_at: local(options.exportedAt),
    count: messages.length,
    first: { id: first.id, at: first.at },
    last: { id: last.id, at: last.at },
    complete_to_start: selection.complete_to_start,
    truncated: selection.truncated,
    current: selection.current,
    left_out: selection.left_out,
    continue: selection.continue,
  }
}

type ExportMeta = ReturnType<typeof exportMeta>

const yesNo = (value: boolean) => (value ? "yes" : "no")

/** How to go on from the export, in words. */
function continueText({ continue: next }: ExportSelection): string {
  const hints = [
    next.older && `older messages: export again with before=${next.older.before}`,
    next.backfill_first && "the mirror reaches no further back: backfill the chat first, then export again",
    next.newer && `newer messages: export again with after=${next.newer.after}`,
  ].filter((hint): hint is string => Boolean(hint))
  return hints.length > 0 ? hints.join("; ") : "nothing"
}

/** The head of a Markdown file: everything a reader needs to cite it. */
function markdownHead(selection: ExportSelection, meta: ExportMeta): string {
  const { chat } = selection
  const server =
    chat.server === null ? "none (a private chat)" : `${oneLine(chat.server_name ?? "unnamed")} (${chat.server})`
  return [
    `# Discord export: ${oneLine(chat.name)}`,
    [
      `- Chat: ${oneLine(chat.name)} (${chat.id}), ${chat.kind}`,
      `- Server: ${server}`,
      `- Messages: ${meta.count}, from ${meta.first.at} (${meta.first.id}) to ${meta.last.at} (${meta.last.id})`,
      `- Time zone: ${meta.time_zone}; exported ${meta.exported_at}`,
      `- Reaches the chat's first message: ${yesNo(meta.complete_to_start)}`,
      `- Cut by limit: ${yesNo(meta.truncated)}`,
      `- Current (a sync run marked the chat in the last 15 minutes): ${yesNo(meta.current)}`,
      `- Left out, stored past the newest message the mirror holds in one piece: ${meta.left_out}`,
      `- Continue: ${continueText(selection)}`,
    ].join("\n"),
    `Note: ${EXPORT_NOTE}`,
  ].join("\n\n")
}

/** What a reply or a forward points at, in words. */
function referenceText(reference: NonNullable<ExportMessage["reply_to"]>): string {
  const message = reference.message === null ? "a message" : `message ${reference.message}`
  return reference.channel === null ? message : `${message} in chat ${reference.channel}`
}

/** The line under a message's heading: its link and id, and what else sets it apart. */
function markdownDetails(message: ExportMessage): string {
  return [
    message.permalink,
    `message ${message.id}`,
    message.reply_to && `reply to ${referenceText(message.reply_to)}`,
    message.forwarded_from && `forwarded from ${referenceText(message.forwarded_from)}`,
    message.edited_at && `edited ${message.edited_at}`,
    message.pinned && "pinned",
    message.event && `event: ${oneLine(message.event)}`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** A titled list, or nothing when there is no item. */
function markdownList(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [[`${title}:`, ...items.map((item) => `- ${item}`)].join("\n")]
}

/** One message of a Markdown file: heading, details, its whole text quoted, then its attachments, embeds, stickers and reactions. */
function markdownMessage(message: ExportMessage): string {
  const author = `${oneLine(message.author ?? "unknown author")} (${message.author_id ?? "no author id"})`
  return [
    `### ${message.at} · ${author}\n${markdownDetails(message)}`,
    ...(message.text === "" ? [] : [quote(message.text)]),
    ...markdownList(
      "Attachments",
      message.attachments.map((file) => {
        const facts = [file.type, file.size === null ? null : `${file.size} bytes`].filter(Boolean).join(", ")
        return `${oneLine(file.name ?? "unnamed")}${facts === "" ? "" : ` (${facts})`}${file.url === null ? "" : `: ${oneLine(file.url)}`}`
      }),
    ),
    ...markdownList(
      "Embeds",
      message.embeds.map((embed) => stringify(embed)),
    ),
    ...markdownList(
      "Stickers",
      message.stickers.map((sticker) => `${oneLine(sticker.name ?? "unnamed")} (${sticker.id})`),
    ),
    ...markdownList(
      "Reactions",
      message.reactions.map(
        (reaction) => `${oneLine(reaction.emoji)} ×${reaction.count}${reaction.me ? " (you reacted)" : ""}`,
      ),
    ),
  ].join("\n\n")
}

/**
 * The text of an export in `options.format`, times written in
 * `options.time_zone` (an IANA name already resolved). Markdown quotes every
 * line of a text, so no text can pass for a heading of the file; JSON is one
 * object (`export`, `note`, `messages`); JSONL has `export` and `note` on its
 * first line and one message per line. Nothing is clipped.
 */
export function renderExport(selection: ExportSelection, options: RenderOptions): string {
  const local = localTimeIn(options.time_zone)
  const messages = selection.messages.map((message) => localMessage(message, local))
  const meta = exportMeta(selection, options, messages, local)
  if (options.format === "markdown") {
    return `${[markdownHead(selection, meta), ...messages.map(markdownMessage)].join("\n\n")}\n`
  }
  if (options.format === "json") {
    return `${stringify({ export: meta, note: EXPORT_NOTE, messages }, 2)}\n`
  }
  return `${[stringify({ export: meta, note: EXPORT_NOTE }), ...messages.map((message) => stringify(message))].join("\n")}\n`
}

/**
 * The name of an export's file: `<chat>-<first day>[-<last day>].<md|json|jsonl>`,
 * the days (`YYYYMMDD`) those of the first and the last message in `zone`;
 * the second only when it differs.
 */
export function exportFileName(
  chat: string,
  firstMs: number,
  lastMs: number,
  zone: string,
  format: ExportFormat,
): string {
  const local = localTimeIn(zone)
  const day = (ms: number) => local(ms).slice(0, 10).replaceAll("-", "")
  const [first, last] = [day(firstMs), day(lastMs)]
  return `${chat}-${first}${last === first ? "" : `-${last}`}.${EXTENSIONS[format]}`
}
