import { openChatSession } from "../chats/session"
import type { ToolContext } from "../tool"
import { locateOptionsOf, prepareOutgoing } from "./outgoing"
import type { FileSendInput, FileSendResult } from "./schemas"
import { destinationOf, postMessage } from "./send"
import { uploadFiles } from "./upload"

/**
 * Sends files, with or without text. The chat and the reply are checked
 * before any file is touched; the files are then copied and checked, and the
 * copies are what is uploaded (removed when the call ends, whatever happens).
 * The message is posted only once every upload has succeeded, as
 * `postMessage` does for a text.
 */
export async function sendFiles(args: FileSendInput, ctx: ToolContext): Promise<FileSendResult> {
  const session = await openChatSession(args, ctx)
  try {
    const destination = destinationOf(session, args)
    const outgoing = await prepareOutgoing(args.files, {
      ...locateOptionsOf(ctx),
      staging: session.paths.outgoing,
      now: session.now,
      signal: session.signal,
    })
    try {
      const text = args.text ?? ""
      const result = await postMessage(session, destination, args, {
        text,
        ledgerText: [text, ...outgoing.files.map((file) => file.sha256)].join("\n"),
        upload: () =>
          uploadFiles(session.client(), destination, outgoing.files, { now: session.now, signal: session.signal }),
      })
      return { ...result, files: outgoing.files.map(({ name, size }) => ({ name, size })) }
    } finally {
      await outgoing.close()
    }
  } finally {
    session.close()
  }
}
