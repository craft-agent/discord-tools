import { withMirror } from "../chats/describe"
import { BYTES_PER_MB } from "../files/size"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { describeSendTarget, lengthFact, type SendTarget } from "./describe"
import { hashFile, locateOptionsOf, locateOutgoing } from "./outgoing"
import type { FileSendInput } from "./schemas"

/** Bytes in a kilobyte, as the `Files` fact counts them. */
const BYTES_PER_KB = 1024

/** The name of the pin that holds the files' hashes. */
const FILES_PIN = "files"

/** `value` rounded to one decimal, without a needless `.0`. */
const oneDecimal = (value: number) => Math.round(value * 10) / 10

/** A size as the `Files` fact shows it: `512 B`, `34 KB`, `1.2 MB`. */
function sizeText(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  const kilobytes = oneDecimal(bytes / BYTES_PER_KB)
  return kilobytes < BYTES_PER_KB ? `${kilobytes} KB` : `${oneDecimal(bytes / BYTES_PER_MB)} MB`
}

/** The `Files` fact: each file's name and size, as `report.pdf (1.2 MB), shot.png (34 KB)`. */
function filesFact(files: readonly { name: string; size: number }[]): CallFact {
  return { label: "Files", value: files.map(({ name, size }) => `${name} (${sizeText(size)})`).join(", ") }
}

/** The headline of a file send: to the chat, or a reply to its author when the mirror names one. */
function headlineOf({ chat, reply }: SendTarget): CallHeadline {
  if (!reply) return { text: "About to send files to {chat}", values: { chat } }
  if (reply.author === null) return { text: "About to reply with files in {chat}", values: { chat } }
  return { text: "About to reply with files to {author} in {chat}", values: { author: reply.author, chat } }
}

/**
 * What a file send will do: from the mirror, the chat, the reply and the
 * notification flags as a text send shows them; from the files, each one's
 * name and size and, as the `files` pin, their SHA-256 hashes in the order
 * given joined with `,`, so a file changed after the prompt makes the call
 * `stale`. The files are found by the rules of the send itself, so a file the
 * send would refuse for where it is, what it is or its size throws the same
 * `invalid_argument`; what the send checks in the copy (names, bytes,
 * archives) is left to the send. `not_found` when the mirror lacks the chat or
 * the message replied to.
 */
export async function describeFileSend(args: FileSendInput, ctx: ToolContext): Promise<CallDescription> {
  const target = await withMirror(args.account, ctx, (mirror) => describeSendTarget(mirror, args))
  const files = await locateOutgoing(args.files, locateOptionsOf(ctx))
  const hashes: string[] = []
  for (const file of files) hashes.push(await hashFile(file.source, ctx.signal))
  return {
    headline: headlineOf(target),
    facts: [...target.facts, filesFact(files), ...(args.text === undefined ? [] : [lengthFact(args.text)])],
    ...(args.text === undefined ? {} : { text: { label: "Message text", body: args.text } }),
    pins: { [FILES_PIN]: hashes.join(",") },
  }
}
