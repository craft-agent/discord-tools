import { describedAction, type DescribedAction } from "../actions/describe"
import { quote, withMirror } from "../chats/describe"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { remindTime } from "./remind"
import type { SavedAddInput, SavedRemoveInput } from "./schemas"

/** The `Message` fact: how the saved message starts; left out when it has no text. */
function messageFact({ message }: DescribedAction): CallFact[] {
  const quoted = quote(message.content)
  return quoted === "" ? [] : [{ label: "Message", value: quoted }]
}

/** The headline of a change to the saved list: the author and the chat, or the chat alone when the mirror has no name for the author. */
function headlineOf(withAuthor: string, without: string, { chat, message }: DescribedAction): CallHeadline {
  return message.author === null
    ? { text: without, values: { chat: chat.name } }
    : { text: withAuthor, values: { author: message.author, chat: chat.name } }
}

/**
 * What a save will do, from the mirror alone: the chat, the reminder (in UTC,
 * or `none`) and the start of the message, under a headline that names its
 * author. A `remind_at` that is not a timestamp with a zone gives no
 * description, and the call is refused when it runs.
 */
export async function describeSavedAdd(args: SavedAddInput, ctx: ToolContext): Promise<CallDescription> {
  const remindAt = args.remind_at === undefined ? undefined : remindTime(args.remind_at)
  return withMirror(args.account, ctx, (mirror) => {
    const action = describedAction(mirror, args)
    return {
      headline: headlineOf(
        "About to save a message by {author} in {chat}",
        "About to save a message in {chat}",
        action,
      ),
      facts: [...action.chat.facts, { label: "Reminder", value: remindAt ?? { text: "none" } }, ...messageFact(action)],
    }
  })
}

/** What removing a save will do, from the mirror alone: the chat and the start of the message, under a headline that names its author. */
export async function describeSavedRemove(args: SavedRemoveInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const action = describedAction(mirror, args)
    return {
      headline: headlineOf(
        "About to remove a saved message by {author} in {chat}",
        "About to remove a saved message in {chat}",
        action,
      ),
      facts: [...action.chat.facts, ...messageFact(action)],
    }
  })
}
