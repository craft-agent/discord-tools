import { describeChat, withMirror } from "../chats/describe"
import { exportsPath } from "../files/private-export"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import type { ExportFormat } from "./export-format"
import { EXPORT_FORMAT_DEFAULT, type ExportInput } from "./export-schemas"
import { EXPORT_LIMIT_DEFAULT } from "./export-select"

/** How each format is named in the `Format` fact. */
const FORMAT_NAMES: Readonly<Record<ExportFormat, string>> = { markdown: "Markdown", json: "JSON", jsonl: "JSONL" }

/** The `Messages` fact: how many messages the export takes and from where, with the bounds exactly as the arguments gave them. */
function messagesFact({ limit, after, before }: ExportInput): CallFact {
  const count = limit ?? EXPORT_LIMIT_DEFAULT
  if (after === undefined) {
    return {
      label: "Messages",
      value:
        before === undefined
          ? { text: "The newest {count}", values: { count } }
          : { text: "The newest {count}, before {before}", values: { count, before } },
    }
  }
  return {
    label: "Messages",
    value:
      before === undefined
        ? { text: "The first {count} after {after}", values: { count, after } }
        : { text: "The first {count} after {after}, before {before}", values: { count, after, before } },
  }
}

/**
 * What an export will do, from the mirror alone: the chat, the format, which
 * messages it takes as the arguments name them and the exports folder. The
 * file's own name depends on what the mirror holds when the call runs, so the
 * prompt names the folder. There is no text: nothing leaves the machine.
 * `not_found` when the mirror lacks the chat, which the export itself refuses.
 */
export async function describeExport(args: ExportInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const chat = describeChat(mirror, args.chat)
    return {
      headline: { text: "About to export {chat}", values: { chat: chat.name } },
      facts: [
        ...chat.facts,
        { label: "Format", value: { text: FORMAT_NAMES[args.format ?? EXPORT_FORMAT_DEFAULT] } },
        messagesFact(args),
        { label: "Folder", value: exportsPath(ctx) },
      ],
    }
  })
}

/** What an export writes to: the exports folder under the download directory. */
export function exportTargets(_args: ExportInput, ctx: ToolContext): string[] {
  return [exportsPath(ctx)]
}
