import { join } from "node:path"
import { quarantine } from "../archive/quarantine"
import { openChatSession } from "../chats/session"
import { actionTarget } from "../actions/target"
import { ToolError } from "../errors"
import type { ToolContext } from "../tool"
import { downloadSettings, ensureDownloadDir } from "./download-dir"
import { collectItems } from "./items"
import { CALL_BUDGET_MS, saveItem } from "./item"
import { saveNote } from "./note"
import { MessageFolder } from "./publish"
import { readMessage } from "./read"
import type { SaveInput, SaveResult, SavedFile } from "./schemas"
import { openStaging } from "./staging"
import { unpackSaved } from "./unpack"

/** The `PATH` the marking program runs with. */
const MARK_PATH = "/usr/bin:/bin"

/** What the marking program is told downloaded the files, where the runtime names no program. */
const DEFAULT_AGENT = "tools"

/**
 * Saves what one message of a chat the mirror knows carries to
 * `<download_dir>/<channel>-<message>/`: its attachments, link preview images
 * and stickers, each checked before it is kept. Everything that can be refused
 * without a request is refused first (the arguments, the settings, the message,
 * the download directory and the message folder); then the message is read
 * again for fresh URLs and each item is downloaded, checked and published in
 * turn, within 540 seconds for the call. An item that is refused or fails is
 * reported and the others go on. Archives are unpacked only with `unpack`.
 */
export async function saveFiles(args: SaveInput, ctx: ToolContext): Promise<SaveResult> {
  if (args.entries !== undefined && args.unpack !== true) {
    throw new ToolError("invalid_argument", "`entries` takes effect only with `unpack: true`.")
  }
  const { dir, maxMb } = downloadSettings(ctx)
  const session = await openChatSession(args, ctx)
  const deadline = session.now() + CALL_BUDGET_MS
  try {
    const { channel } = actionTarget(session, args.channel, args.message)
    await ensureDownloadDir(dir, ctx)
    const folder = new MessageFolder(join(dir, `${args.channel}-${args.message}`))
    await folder.check()

    const items = collectItems(await readMessage(session, channel, args.message))
    if (items.length === 0) {
      throw new ToolError(
        "invalid_argument",
        `Message ${args.message} carries no attachments, link previews or stickers.`,
      )
    }

    const mark = (paths: string[]) =>
      quarantine(paths, {
        agent: ctx.runtime?.cli ?? DEFAULT_AGENT,
        env: { PATH: MARK_PATH },
        now: ctx.runtime?.now ?? Date.now,
        signal: session.signal,
      })
    const files: SavedFile[] = []
    const staging = await openStaging(session.paths.incoming, session.now())
    try {
      const run = {
        client: session.client(),
        staging,
        folder,
        maxMb,
        deadline,
        now: session.now,
        mark,
        signal: session.signal,
      }
      for (const [index, item] of items.entries()) files.push(await saveItem(item, index + 1, run))
    } finally {
      await staging.remove()
    }
    if (args.unpack) await unpackSaved(files, { entries: args.entries, mark, signal: session.signal })

    const kept = files.some((file) => file.status === "saved" || file.status === "already")
    return {
      channel: args.channel,
      id: args.message,
      folder: kept ? folder.path : null,
      files,
      note: saveNote(files),
    }
  } finally {
    session.close()
  }
}
