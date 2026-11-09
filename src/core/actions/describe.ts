import { createHash } from "node:crypto"
import {
  describeChat,
  mirroredMessage,
  quote,
  withMirror,
  type DescribedChat,
  type MirroredMessage,
} from "../chats/describe"
import { ToolError } from "../errors"
import type { Mirror } from "../discord/mirror"
import { lengthFact, massMentionsFacts } from "../sends/describe"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { shownEmoji } from "./emoji"
import type { ActionInput, DeleteInput, EditInput, PinInput, ReactionInput } from "./schemas"

/** The chat and the message an action on a message targets, as the mirror holds them. */
export type DescribedAction = { chat: DescribedChat; message: MirroredMessage }

/**
 * The chat and the message of an action from the mirror. `not_found` when the
 * mirror lacks either, which the action itself refuses.
 */
export function describedAction(mirror: Mirror, { channel, message }: ActionInput): DescribedAction {
  const chat = describeChat(mirror, channel)
  const found = mirroredMessage(mirror, channel, message)
  if (!found) throw new ToolError("not_found", `The mirror holds no message ${message} in channel ${channel}.`)
  return { chat, message: found }
}

/**
 * The `Author` and `Message` facts of a message, so an approval prompt shows
 * whose message it is and how it starts. The author is left out when the
 * mirror has no name for someone else's message, the quote when it is empty.
 */
export function messageFacts(message: MirroredMessage): CallFact[] {
  const author = message.fromMe ? { text: "You" } : message.author
  const quoted = quote(message.content)
  return [
    ...(author === null ? [] : [{ label: "Author", value: author }]),
    ...(quoted === "" ? [] : [{ label: "Message", value: quoted }]),
  ]
}

/** The SHA-256 of a text as hex, which a pin holds in place of the text itself. */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * What an edit will do, from the mirror alone: the chat, the text it replaces,
 * the notification flag, the new text's length and the new text. The
 * `current_text` pin holds a hash of the whole stored text, so an edit that
 * changed it past the quoted part is still caught when the call runs.
 */
export async function describeEdit(args: EditInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const { chat, message } = describedAction(mirror, args)
    const current = quote(message.content)
    const facts: CallFact[] = [
      ...chat.facts,
      ...(current === "" ? [] : [{ label: "Current text", value: current }]),
      ...massMentionsFacts(args.mass_mentions),
      lengthFact(args.text),
    ]
    return {
      headline: { text: "About to edit your message in {chat}", values: { chat: chat.name } },
      facts,
      text: { label: "New text", body: args.text },
      pins: { current_text: textHash(message.content) },
    }
  })
}

/**
 * What a delete will do, from the mirror alone: the chat and the whole text it
 * removes. The text is never quoted, since a delete cannot be undone and the
 * person should see all of what is lost before approving.
 */
export async function describeDelete(args: DeleteInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const { chat, message } = describedAction(mirror, args)
    return {
      headline: { text: "About to delete your message in {chat}", values: { chat: chat.name } },
      facts: chat.facts,
      text: { label: "Message to delete", body: message.content },
    }
  })
}

/** An action that changes nothing in the message: the chat and the message it is on, under the headline `headline` names from the chat. */
function describeOnMessage(
  args: ActionInput,
  ctx: ToolContext,
  headline: (chat: string) => CallHeadline,
): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const { chat, message } = describedAction(mirror, args)
    return { headline: headline(chat.name), facts: [...chat.facts, ...messageFacts(message)] }
  })
}

/** What adding a reaction will do: the chat, the emoji (a custom one by its name) and the message reacted to. */
export function describeReactionAdd(args: ReactionInput, ctx: ToolContext): Promise<CallDescription> {
  const emoji = shownEmoji(args.emoji)
  return describeOnMessage(args, ctx, (chat) => ({
    text: "About to react with {emoji} in {chat}",
    values: { emoji, chat },
  }))
}

/** What taking back a reaction will do: the chat, the emoji (a custom one by its name) and the message it is on. */
export function describeReactionRemove(args: ReactionInput, ctx: ToolContext): Promise<CallDescription> {
  const emoji = shownEmoji(args.emoji)
  return describeOnMessage(args, ctx, (chat) => ({
    text: "About to remove your {emoji} reaction in {chat}",
    values: { emoji, chat },
  }))
}

/** What a pin will do: the chat and the message pinned, whose author and start the person sees. */
export function describePinAdd(args: PinInput, ctx: ToolContext): Promise<CallDescription> {
  return describeOnMessage(args, ctx, (chat) => ({ text: "About to pin a message in {chat}", values: { chat } }))
}

/** What an unpin will do: the chat and the message unpinned, whose author and start the person sees. */
export function describePinRemove(args: PinInput, ctx: ToolContext): Promise<CallDescription> {
  return describeOnMessage(args, ctx, (chat) => ({ text: "About to unpin a message in {chat}", values: { chat } }))
}
