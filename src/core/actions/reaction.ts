import { openChatSession } from "../chats/session"
import { adjustOwnReaction, emojiKey, storedReactions } from "../discord/ingest"
import { fieldOf, listOf, type JsonRecord } from "../discord/ingest-values"
import { ToolError } from "../errors"
import { StepErrors, type ToolContext } from "../tool"
import { reactionEmoji } from "./emoji"
import type { ReactionInput, ReactionResult } from "./schemas"
import { actionTarget } from "./target"
import { runAction, type ActionRequest } from "./write"

/** What a result says when the reaction was added on Discord and the mirror follows it. */
export const REACTION_ADDED_NOTE = "The reaction was added on Discord and the local mirror shows it."

/** What a result says when the reaction was taken back on Discord and the mirror follows it. */
export const REACTION_REMOVED_NOTE = "The reaction was removed on Discord and the local mirror no longer shows it."

/** What a result says when Discord took the reaction but the mirror did not store it. */
export const REACTION_UNSTORED_NOTE =
  "The reaction was changed on Discord, but the local mirror could not store it (see `errors`); reading the message live (discord_chat_read method messages, live) refreshes it."

/** What an `uncertain` reaction says: it may have landed, and `details.applied` is the read-back's hint. */
const UNCERTAIN_MESSAGE =
  "The reaction may have reached Discord, and it was not sent again. `details.applied` says whether a read-back saw the reaction in the state asked for (null when it could not tell). Repeating the same call is harmless, but ask the user first; discord_chat_read (method messages, live) shows the message as it is now."

/** The query of the add request, as the web client sends it: a normal reaction, never a super reaction. */
const ADD_QUERY = { location: "Message", type: 0 } as const

/**
 * Whether the read-back shows the account's own reaction to `emoji` as asked
 * for: present when `add`, absent otherwise. A reaction that is not listed
 * counts as not the account's; a message that is absent proves nothing.
 */
function shownAs(found: JsonRecord | undefined, emoji: string, add: boolean): boolean {
  if (found === undefined) return false
  const entry = listOf(found.reactions).find((reaction) => emojiKey(fieldOf(reaction, "emoji")) === emoji)
  return (fieldOf(entry, "me") === true) === add
}

/** Refuses taking back a reaction when the mirror knows the message's reactions and shows none of the account's own for `emoji`. */
function checkTakenBackIsOwn(reactions: string | null, emoji: string, message: string): void {
  if (reactions === null) return
  const stored = storedReactions(reactions)
  if (stored === null || stored.some((reaction) => reaction.emoji === emoji && reaction.me)) return
  throw new ToolError(
    "not_found",
    `The mirror shows no reaction ${emoji} by the account on message ${message}; read the message live to refresh it.`,
  )
}

/**
 * Adds or takes back the account's own reaction on a message of a chat the
 * mirror knows, whoever wrote it. Refused without a request when the mirror
 * does not hold the message, the emoji is not one this tool takes, or (taking
 * back) the mirror shows no reaction of the account's own. The request is sent
 * once and never retried; every failure that may have reached Discord is
 * `uncertain`.
 */
async function react(args: ReactionInput, ctx: ToolContext, add: boolean): Promise<ReactionResult> {
  const session = await openChatSession(args, ctx)
  try {
    const target = actionTarget(session, args.channel, args.message)
    const emoji = reactionEmoji(args.emoji, target.message)
    if (!add) checkTakenBackIsOwn(target.message.reactions, emoji, args.message)

    const own = `/channels/${args.channel}/messages/${args.message}/reactions/${encodeURIComponent(emoji)}`
    const request: ActionRequest = add
      ? { method: "PUT", path: `${own}/@me`, referer: target.channel.referer, query: ADD_QUERY }
      : { method: "DELETE", path: `${own}/0/@me`, referer: target.channel.referer }
    await runAction(session, target, request, (found) => shownAs(found, emoji, add), UNCERTAIN_MESSAGE)

    // Discord took the change: a failure to follow it in the mirror is reported, never thrown.
    const steps = new StepErrors()
    await steps.record("store", async () =>
      session.store(() => adjustOwnReaction(session.mirror, args.message, emoji, add)),
    )
    return {
      id: args.message,
      channel: args.channel,
      emoji,
      note: steps.any ? REACTION_UNSTORED_NOTE : add ? REACTION_ADDED_NOTE : REACTION_REMOVED_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}

/** Adds the account's own reaction; adding one already there is sent all the same and changes nothing. */
export function addReaction(args: ReactionInput, ctx: ToolContext): Promise<ReactionResult> {
  return react(args, ctx, true)
}

/** Takes back the account's own reaction. */
export function removeReaction(args: ReactionInput, ctx: ToolContext): Promise<ReactionResult> {
  return react(args, ctx, false)
}
