import { storedReactions } from "../discord/ingest"
import { isSnowflake } from "../discord/snowflake"
import { ToolError } from "../errors"
import type { ActionMessage } from "./target"

/** The way Discord writes a custom emoji in a message, `<:name:id>` or `<a:name:id>`; the group is `name:id`. */
const MENTION_FORM = /^<a?:(.+)>$/

/** A custom emoji as `name:id`; the group is the id. */
const CUSTOM_EMOJI = /^[A-Za-z0-9_~]{1,32}:([0-9]+)$/

/** What a Unicode emoji looks like: a pictograph or a flag letter; a keycap is a digit, `#` or `*` with its combining mark. */
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const NOT_ON_MESSAGE =
  "A custom emoji can only be used when it is already on that message; read the message live (discord_chat_read method messages, live) to see its reactions."
const NOT_AN_EMOJI = "emoji must be one Unicode emoji, or a custom emoji already on that message (name:id)"

/** Whether `text` is exactly one Unicode emoji: a single grapheme that is a pictograph, a flag or a keycap. */
function isUnicodeEmoji(text: string): boolean {
  const [first, ...rest] = Array.from(GRAPHEMES.segment(text), (part) => part.segment)
  return first !== undefined && rest.length === 0 && (PICTOGRAPH.test(first) || KEYCAP.test(first))
}

/**
 * The emoji of a reaction as the API path and the mirror spell it (the
 * character, or `name:id`), from what the caller wrote. A custom emoji is
 * accepted only when the message's stored reactions already hold it, and the
 * stored spelling is the one returned; otherwise it is `invalid_argument`, as
 * is anything that is not exactly one Unicode emoji.
 */
export function reactionEmoji(input: string, message: ActionMessage): string {
  const custom = CUSTOM_EMOJI.exec(MENTION_FORM.exec(input)?.[1] ?? input)
  const id = custom?.[1]
  if (id !== undefined && isSnowflake(id)) {
    const held = storedReactions(message.reactions)?.find((reaction) => reaction.emoji.endsWith(`:${id}`))
    if (!held) throw new ToolError("invalid_argument", NOT_ON_MESSAGE)
    return held.emoji
  }
  if (!isUnicodeEmoji(input)) throw new ToolError("invalid_argument", NOT_AN_EMOJI)
  return input
}
