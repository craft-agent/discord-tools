import { mirroredChannelId } from "../chats/channel-target"
import { openChatSession } from "../chats/session"
import type { ToolContext } from "../tool"
import { postTags } from "./post-args"
import type { PostCreateInput, PostCreateResult } from "./post-schemas"
import { sendPost } from "./post"

/**
 * Posts a text in a forum or media channel the mirror knows, with tags the
 * mirror lists for it. Every refusal that can be told from the mirror comes
 * before any request; the post itself is made as `sendPost` does.
 */
export async function createPost(args: PostCreateInput, ctx: ToolContext): Promise<PostCreateResult> {
  const session = await openChatSession(args, ctx)
  try {
    const forum = mirroredChannelId(session, args.channel)
    postTags(session.mirror, args)
    return await sendPost(session, forum, args)
  } finally {
    session.close()
  }
}
