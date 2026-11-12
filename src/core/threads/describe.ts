import { messageFacts } from "../actions/describe"
import { describeChat, mirroredMessage, withMirror } from "../chats/describe"
import { ToolError } from "../errors"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import type { AUTO_ARCHIVE_MINUTES, ThreadCreateInput } from "./schemas"

/** How the `Archives after` fact words each accepted duration. */
const ARCHIVE_WORDS: Readonly<Record<(typeof AUTO_ARCHIVE_MINUTES)[number], string>> = {
  60: "1 hour",
  1440: "1 day",
  4320: "3 days",
  10080: "1 week",
}

/** What the `Archives after` fact says when no duration is given. */
const ARCHIVE_DEFAULT = "Discord's default"

/** The `Visibility` fact: `Private` only when asked for, else `Public`. */
function visibilityFact(isPrivate: boolean | undefined): CallFact {
  return { label: "Visibility", value: { text: isPrivate === true ? "Private" : "Public" } }
}

/** The `Archives after` fact: the duration as words, else Discord's default. */
function archiveFact(minutes: ThreadCreateInput["auto_archive"]): CallFact {
  return { label: "Archives after", value: { text: minutes === undefined ? ARCHIVE_DEFAULT : ARCHIVE_WORDS[minutes] } }
}

/**
 * What a thread creation will do, from the mirror alone: the channel it starts
 * in, the message it starts from (its author and a short quote), the name as
 * given, public or private, and when it archives. `not_found` when the mirror
 * lacks the channel or the message, which the creation itself refuses.
 */
export async function describeThreadCreate(args: ThreadCreateInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const chat = describeChat(mirror, args.channel)
    const message = args.message === undefined ? undefined : mirroredMessage(mirror, args.channel, args.message)
    if (args.message !== undefined && !message) {
      throw new ToolError("not_found", `The mirror holds no message ${args.message} in channel ${args.channel}.`)
    }
    return {
      headline: { text: "About to start a thread in {chat}", values: { chat: chat.name } },
      facts: [
        ...chat.facts,
        ...(message ? messageFacts(message) : []),
        { label: "Name", value: args.name },
        visibilityFact(args.private),
        archiveFact(args.auto_archive),
      ],
    }
  })
}
