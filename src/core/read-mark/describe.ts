import { describedAction } from "../actions/describe"
import { withMirror } from "../chats/describe"
import { headlineOf, messageFact } from "../saved/describe"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import type { ReadMarkInput } from "./schemas"
import { newestMessageId } from "./target"

/** The name of the pin that holds the newest message a prompt resolved, when the call left the message out. */
const MESSAGE_PIN = "message"

/** The `Read state` fact: what the mark does to the chat's unread state. */
const READ_STATE_FACT: CallFact = { label: "Read state", value: { text: "cleared on every device up to this message" } }

/**
 * What a read mark will do, from the mirror alone: the chat, the start of the
 * message it is up to and what it does to the read state, under a headline
 * that names the message's author. A message left out is the newest the mirror
 * holds, resolved as the call resolves it and pinned as `message`, so a newer
 * message mirrored after the prompt makes the call `stale` instead of marking
 * past what the person saw.
 */
export async function describeReadMark(args: ReadMarkInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const message = args.message ?? newestMessageId(mirror, args.channel)
    const action = describedAction(mirror, { channel: args.channel, message })
    return {
      headline: headlineOf(
        "About to mark {chat} read up to a message by {author}",
        "About to mark {chat} read",
        action,
      ),
      facts: [...action.chat.facts, ...messageFact(action), READ_STATE_FACT],
      ...(args.message === undefined ? { pins: { [MESSAGE_PIN]: message } } : {}),
    }
  })
}
