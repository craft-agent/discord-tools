import { withMirror } from "../chats/describe"
import { lengthFact } from "../sends/describe"
import { describeFiles } from "../sends/file-describe"
import type { CallDescription, ToolContext } from "../tool"
import type { FilePostInput } from "./file-post-schemas"
import { describePostTarget, postHeadline } from "./post-describe"

/**
 * What a post with files will do: from the mirror, the forum, the name, the
 * tags and the notification flags as a post shows them; from the files, each
 * one's name and size and the `files` pin of their hashes, as a file send
 * does, so a file changed after the prompt makes the call `stale`. The length
 * and the text are those of the first message, left out when only files go. A
 * file the send would refuse for where it is, what it is or its size throws
 * the same `invalid_argument`; what the send checks in the copy is left to it.
 */
export async function describeFilePost(args: FilePostInput, ctx: ToolContext): Promise<CallDescription> {
  const target = await withMirror(args.account, ctx, (mirror) => describePostTarget(mirror, args))
  const { fact, pins } = await describeFiles(args.files, ctx)
  return {
    headline: postHeadline(target.chat),
    facts: [...target.facts, fact, ...(args.text === undefined ? [] : [lengthFact(args.text)])],
    ...(args.text === undefined ? {} : { text: { label: "Message text", body: args.text } }),
    pins,
  }
}
