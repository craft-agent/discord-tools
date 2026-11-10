import { describeChat, mirroredMessage, quote, withMirror } from "../chats/describe"
import { ToolError } from "../errors"
import type { Mirror } from "../discord/mirror"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import type { SendInput } from "./schemas"

/** The `Length` fact: how many characters the text has, counted in code points, as `1 character` or `42 characters`. */
export function lengthFact(text: string): CallFact {
  const count = Array.from(text).length
  return {
    label: "Length",
    value: { text: count === 1 ? "{count} character" : "{count} characters", values: { count } },
  }
}

/** The `Mass mentions` fact, only when the call lets `@everyone`, `@here` and role mentions notify. */
export function massMentionsFacts(massMentions: boolean | undefined): CallFact[] {
  return massMentions === true ? [{ label: "Mass mentions", value: { text: "Notify" } }] : []
}

/** The headline of a send: to the chat, or a reply to its author when the mirror names one. */
function headlineOf(chat: string, reply?: { author: string | null }): CallHeadline {
  if (!reply) return { text: "About to send a message to {chat}", values: { chat } }
  if (reply.author === null) return { text: "About to reply in {chat}", values: { chat } }
  return { text: "About to reply to {author} in {chat}", values: { author: reply.author, chat } }
}

/** What every send shows of where it goes: the chat's name, the author replied to (if the mirror names one) and the facts up to the notification flags. */
export type SendTarget = { chat: string; reply?: { author: string | null }; facts: CallFact[] }

/**
 * The chat a send goes to, the message it replies to and the facts they share
 * with every send (the chat, the reply, mass mentions, notifications), from
 * the mirror alone. `not_found` when the mirror lacks the chat or the message
 * replied to, which the send itself refuses.
 */
export function describeSendTarget(
  mirror: Mirror,
  args: Pick<SendInput, "channel" | "reply_to" | "mass_mentions" | "silent">,
): SendTarget {
  const chat = describeChat(mirror, args.channel)
  const reply = args.reply_to === undefined ? undefined : mirroredMessage(mirror, args.channel, args.reply_to)
  if (args.reply_to !== undefined && !reply) {
    throw new ToolError("not_found", `The mirror holds no message ${args.reply_to} in channel ${args.channel}.`)
  }
  const quoted = reply ? quote(reply.content) : ""
  return {
    chat: chat.name,
    ...(reply ? { reply } : {}),
    facts: [
      ...chat.facts,
      ...(quoted === "" ? [] : [{ label: "Reply to", value: quoted }]),
      ...massMentionsFacts(args.mass_mentions),
      ...(args.silent === true ? [{ label: "Notifications", value: { text: "Silent" } }] : []),
    ],
  }
}

/**
 * What a send will do, from the mirror alone: the chat it goes to, the message
 * it replies to, the notification flags, the text's length and the text.
 * `not_found` when the mirror lacks the chat or the message replied to, which
 * the send itself refuses.
 */
export async function describeSend(args: SendInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const target = describeSendTarget(mirror, args)
    return {
      headline: headlineOf(target.chat, target.reply),
      facts: [...target.facts, lengthFact(args.text)],
      text: { label: "Message text", body: args.text },
    }
  })
}
