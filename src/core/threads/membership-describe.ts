import { describeChat, withMirror } from "../chats/describe"
import type { CallDescription, ToolContext } from "../tool"
import type { ThreadMembershipInput } from "./membership-schemas"

/**
 * A change of membership in a thread, from the mirror alone: the thread's name
 * under the headline `text` and its chat facts, with no text. `not_found` when
 * the mirror lacks the channel, which the call itself refuses.
 */
function describeMembership(args: ThreadMembershipInput, ctx: ToolContext, text: string): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const chat = describeChat(mirror, args.thread)
    return { headline: { text, values: { chat: chat.name } }, facts: chat.facts }
  })
}

/** What a join will do: the thread, as people see it, and its kind, server and channel. */
export function describeThreadJoin(args: ThreadMembershipInput, ctx: ToolContext): Promise<CallDescription> {
  return describeMembership(args, ctx, "About to join {chat}")
}

/** What a leave will do: the thread, as people see it, and its kind, server and channel. */
export function describeThreadLeave(args: ThreadMembershipInput, ctx: ToolContext): Promise<CallDescription> {
  return describeMembership(args, ctx, "About to leave {chat}")
}
