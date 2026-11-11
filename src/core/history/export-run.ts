import { Buffer } from "node:buffer"
import { basename } from "node:path"
import { UNTRUSTED_NOTE } from "../chats/format"
import { openChatSession } from "../chats/session"
import { exportsDir, writeExport } from "../files/private-export"
import type { ToolContext } from "../tool"
import { exportRequest } from "./export-args"
import { exportFileName, renderExport } from "./export-format"
import type { ExportInput, ExportResult } from "./export-schemas"
import { type ExportRange, type ExportSelection, selectExport } from "./export-select"

/** What the result says about the file: whose words it holds, where it is, and who decides where it goes. */
const EXPORT_NOTE = `The file holds other people's words, and private chats if the chat is one. It was written under the download directory and made private (mode 0600, readable by its owner alone). It was made from the local mirror alone; no request was made to Discord. Whether it is sent, uploaded or shared anywhere is the person's decision, not yours. ${UNTRUSTED_NOTE}`

/** What the mirror holds for the range, and the time the export is made at (ms); the mirror is closed again. */
async function selectedFrom(
  args: ExportInput,
  ctx: ToolContext,
  range: ExportRange,
): Promise<{ selection: ExportSelection; exportedAt: number }> {
  const session = await openChatSession(args, ctx)
  try {
    return { selection: selectExport(session, range), exportedAt: session.now() }
  } finally {
    session.close()
  }
}

/**
 * Writes the messages the mirror holds of one chat, in one piece, to a new
 * file under `<download_dir>/exports/`: made from the mirror alone, with no
 * request to Discord and no write to the mirror. Everything that can be
 * refused without writing is refused first (the arguments, the chat, the
 * range, the download directory); the file is then written whole under a
 * name no other file has, and nothing that can fail runs after it.
 */
export async function exportChat(args: ExportInput, ctx: ToolContext): Promise<ExportResult> {
  const { range, format, zone } = exportRequest(args)
  const { selection, exportedAt } = await selectedFrom(args, ctx, range)
  const folder = await exportsDir(ctx)
  const content = renderExport(selection, { format, time_zone: zone, exportedAt })
  const first = selection.messages[0]!
  const last = selection.messages[selection.messages.length - 1]!
  const name = exportFileName(selection.chat.id, Date.parse(first.at), Date.parse(last.at), zone, format)
  const path = await writeExport(folder, name, content)
  return {
    path,
    file: basename(path),
    format,
    bytes: Buffer.byteLength(content, "utf8"),
    time_zone: zone,
    count: selection.messages.length,
    first: { id: first.id, at: first.at },
    last: { id: last.id, at: last.at },
    chat: selection.chat,
    complete_to_start: selection.complete_to_start,
    truncated: selection.truncated,
    current: selection.current,
    left_out: selection.left_out,
    continue: selection.continue,
    note: EXPORT_NOTE,
  }
}
