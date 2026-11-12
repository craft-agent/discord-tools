import { describeChat, withMirror } from "../chats/describe"
import type { Mirror } from "../discord/mirror"
import { massMentionsFacts, lengthFact, silentFacts } from "../sends/describe"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import { postTags } from "./post-args"
import type { PostCreateInput } from "./post-schemas"

/** The separator of the names in the `Tags` fact. */
const TAG_SEPARATOR = ", "

/** What every post shows of where it goes and what it is: the forum's name and the facts up to the notification flags. */
export type PostTarget = { chat: string; facts: CallFact[] }

/**
 * The forum a post goes in and the facts every post shares (the chat, the name
 * as given, the tags by the names the mirror holds, mass mentions and
 * notifications), from the mirror alone. Refuses as the post itself does for a
 * channel, a tag or a missing tag, which gives no description.
 */
export function describePostTarget(
  mirror: Mirror,
  args: Pick<PostCreateInput, "channel" | "name" | "tags" | "mass_mentions" | "silent">,
): PostTarget {
  const chat = describeChat(mirror, args.channel)
  const tags = postTags(mirror, args)
  return {
    chat: chat.name,
    facts: [
      ...chat.facts,
      { label: "Name", value: args.name },
      ...(tags.length === 0 ? [] : [{ label: "Tags", value: tags.map((tag) => tag.name).join(TAG_SEPARATOR) }]),
      ...massMentionsFacts(args.mass_mentions),
      ...silentFacts(args.silent),
    ],
  }
}

/**
 * What a post will do, from the mirror alone: the forum, the name, the tags,
 * the notification flags, the text's length and the text as the first message.
 */
export async function describePostCreate(args: PostCreateInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const target = describePostTarget(mirror, args)
    return {
      headline: { text: "About to post in {chat}", values: { chat: target.chat } },
      facts: [...target.facts, lengthFact(args.text)],
      text: { label: "Message text", body: args.text },
    }
  })
}
