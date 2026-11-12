import { mirroredChannelId } from "../chats/channel-target"
import { openChatSession } from "../chats/session"
import { locateOptionsOf, prepareOutgoing } from "../sends/outgoing"
import { uploadFiles } from "../sends/upload"
import type { ToolContext } from "../tool"
import type { FilePostInput, FilePostResult } from "./file-post-schemas"
import { postTags } from "./post-args"
import { sendPost } from "./post"

/**
 * Posts in a forum or media channel with files on the first message, text
 * optional. Everything the mirror can refuse (the channel, the tags) comes
 * before any file is touched; the files are then copied and checked, and the
 * copies are what is uploaded to the forum (removed when the call ends,
 * whatever happens). The post is requested only once every upload has
 * succeeded, as `sendPost` does for a text.
 */
export async function createFilePost(args: FilePostInput, ctx: ToolContext): Promise<FilePostResult> {
  const session = await openChatSession(args, ctx)
  try {
    const forum = mirroredChannelId(session, args.channel)
    postTags(session.mirror, args)
    const outgoing = await prepareOutgoing(args.files, {
      ...locateOptionsOf(ctx),
      staging: session.paths.outgoing,
      now: session.now,
      signal: session.signal,
    })
    try {
      const attachments = await uploadFiles(session.client(), forum.target, outgoing.files, {
        now: session.now,
        signal: session.signal,
      })
      const result = await sendPost(session, forum, { ...args, attachments })
      return { ...result, files: outgoing.files.map(({ name, size }) => ({ name, size })) }
    } finally {
      await outgoing.close()
    }
  } finally {
    session.close()
  }
}
