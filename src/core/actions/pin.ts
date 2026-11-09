import { openChatSession } from "../chats/session"
import { setPinned } from "../discord/ingest"
import type { JsonRecord } from "../discord/ingest-values"
import { ToolError } from "../errors"
import { StepErrors, type ToolContext } from "../tool"
import type { PinInput, PinResult } from "./schemas"
import { actionTarget } from "./target"
import { runAction, type ActionRequest } from "./write"

/** What a result says when the message was pinned on Discord and the mirror follows it. */
export const PIN_ADDED_NOTE = "The message was pinned on Discord and the local mirror shows it pinned."

/** What a result says when the message was unpinned on Discord and the mirror follows it. */
export const PIN_REMOVED_NOTE = "The message was unpinned on Discord and the local mirror no longer shows it pinned."

/** What a result says when Discord took the change but the mirror did not store it. */
export const PIN_UNSTORED_NOTE =
  "The pin was changed on Discord, but the local mirror could not store it (see `errors`); reading the message live (discord_chat_read method messages, live) refreshes it."

/** What an `uncertain` pin says: it may have landed, and `details.applied` is the read-back's hint. */
const UNCERTAIN_MESSAGE =
  "The pin change may have reached Discord, and it was not sent again. `details.applied` says whether a read-back saw the message in the state asked for (null when it could not tell). Repeating the same call is harmless, but ask the user first; discord_chat_read (method messages, live) shows the message as it is now."

/** The message types Discord lets be pinned: a plain message (0) and a reply (19). */
const PINNABLE_TYPES: readonly number[] = [0, 19]

/** Whether the read-back shows the message pinned as asked for; a message that is absent proves nothing. */
function shownAs(found: JsonRecord | undefined, add: boolean): boolean {
  return found !== undefined && (found.pinned === true) === add
}

/**
 * Pins or unpins a message of a chat the mirror knows, whoever wrote it.
 * Refused without a request when the mirror does not hold the message or (to
 * pin) it is a system message. The mirror's own pinned flag is not consulted:
 * Discord decides. The request is sent once and never retried; every failure
 * that may have reached Discord is `uncertain`.
 */
async function pin(args: PinInput, ctx: ToolContext, add: boolean): Promise<PinResult> {
  const session = await openChatSession(args, ctx)
  try {
    const target = actionTarget(session, args.channel, args.message)
    if (add && !PINNABLE_TYPES.includes(target.message.type)) {
      throw new ToolError(
        "invalid_argument",
        `Only a plain message or a reply can be pinned; message ${args.message} is a system message.`,
      )
    }

    const request: ActionRequest = {
      method: add ? "PUT" : "DELETE",
      path: `/channels/${args.channel}/messages/pins/${args.message}`,
      referer: target.channel.referer,
    }
    await runAction(session, target, request, (found) => shownAs(found, add), UNCERTAIN_MESSAGE)

    // Discord took the change: a failure to follow it in the mirror is reported, never thrown.
    const steps = new StepErrors()
    await steps.record("store", async () => session.store(() => setPinned(session.mirror, args.message, add)))
    return {
      id: args.message,
      channel: args.channel,
      pinned: add,
      note: steps.any ? PIN_UNSTORED_NOTE : add ? PIN_ADDED_NOTE : PIN_REMOVED_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}

/** Pins a message; pinning one that is already pinned is sent all the same and changes nothing. */
export function addPin(args: PinInput, ctx: ToolContext): Promise<PinResult> {
  return pin(args, ctx, true)
}

/** Unpins a message; unpinning one that is not pinned is sent all the same and changes nothing. */
export function removePin(args: PinInput, ctx: ToolContext): Promise<PinResult> {
  return pin(args, ctx, false)
}
