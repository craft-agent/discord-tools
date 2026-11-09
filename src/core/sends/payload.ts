import { randomInt } from "node:crypto"
import { fieldOf, idText, isRecord, type JsonRecord } from "../discord/ingest-values"
import { isSnowflake, snowflakeAt, snowflakeTime } from "../discord/snowflake"

/** The message flag that sends without a push or desktop notification. */
export const SUPPRESS_NOTIFICATIONS = 4096

/** How many of the channel's newest messages the read-back after an uncertain send fetches. */
export const READ_BACK_LIMIT = 10

/** How far before the send the read-back still counts a message, in milliseconds: the account's clock and Discord's differ a little. */
export const READ_BACK_SLACK_MS = 2000

/** The bits of a snowflake below its timestamp, which a nonce fills with random bits. */
const NONCE_RANDOM_RANGE = 2 ** 22

/** The `allowed_mentions.parse` kinds of a send: users always, roles and `@everyone`/`@here` only when asked. */
const PLAIN_MENTIONS = ["users"]
const MASS_MENTIONS = ["users", "roles", "everyone"]

/** The `allowed_mentions` of a request that carries message text. */
export type AllowedMentions = { parse: readonly string[]; replied_user: false }

/** The body of the request that sends a message, as the web client builds it. */
export type SendBody = {
  mobile_network_type: "unknown"
  content: string
  nonce: string
  tts: false
  enforce_nonce: true
  flags: number
  allowed_mentions: AllowedMentions
  message_reference?: { channel_id: string; message_id: string; guild_id?: string; fail_if_not_exists: true }
}

/** What a send says: the text, whether it is silent or may notify everyone, and the message it answers. */
export type SendSpec = {
  text: string
  nonce: string
  silent: boolean
  massMentions: boolean
  reply?: { channel: string; message: string; server: string | null }
}

/** A fresh nonce: a valid snowflake at `now` whose low 22 bits are random, so two sends in a millisecond differ. */
export function newNonce(now: number): string {
  return String(BigInt(snowflakeAt(now)) | BigInt(randomInt(0, NONCE_RANDOM_RANGE)))
}

/** Who the text may notify: users always, roles and `@everyone`/`@here` only with `massMentions`; a reply never pings its author. */
export function allowedMentions(massMentions: boolean): AllowedMentions {
  return { parse: massMentions ? MASS_MENTIONS : PLAIN_MENTIONS, replied_user: false }
}

/** The request body of a send. A reply never pings its author, and the text is sent exactly as given. */
export function sendBody({ text, nonce, silent, massMentions, reply }: SendSpec): SendBody {
  return {
    mobile_network_type: "unknown",
    content: text,
    nonce,
    tts: false,
    enforce_nonce: true,
    flags: silent ? SUPPRESS_NOTIFICATIONS : 0,
    allowed_mentions: allowedMentions(massMentions),
    ...(reply
      ? {
          message_reference: {
            channel_id: reply.channel,
            message_id: reply.message,
            ...(reply.server === null ? {} : { guild_id: reply.server }),
            fail_if_not_exists: true,
          },
        }
      : {}),
  }
}

/** The message Discord answered a send with, as it sent it, with its id checked. */
export type SentMessage = JsonRecord & { id: string }

/**
 * The message Discord answered a send with, or `undefined` when the answer is
 * not that message: an object with a snowflake `id`, in `channel`, by `me`,
 * and, when it carries a nonce, ours.
 */
export function sentMessage(
  value: unknown,
  expected: { channel: string; me: string; nonce: string },
): SentMessage | undefined {
  if (!isRecord(value) || !isSnowflake(value.id)) return undefined
  if (value.channel_id !== expected.channel || fieldOf(value.author, "id") !== expected.me) return undefined
  if (value.nonce !== undefined && value.nonce !== expected.nonce) return undefined
  return { ...value, id: value.id }
}

/**
 * The ids of the messages in a channel's newest-messages answer that look like
 * the send: by `me`, with exactly `text`, made at or after `since`, and a reply
 * to `replyTo` exactly when the send was one. Newest first; an answer that is
 * not a list has none.
 */
export function readBackMatches(
  value: unknown,
  { me, text, replyTo, since }: { me: string; text: string; replyTo: string | undefined; since: number },
): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .flatMap((message) => {
      const id = idText(message.id)
      if (id === null || fieldOf(message.author, "id") !== me || message.content !== text) return []
      if (snowflakeTime(id) < since) return []
      const answers =
        replyTo === undefined
          ? message.message_reference == null
          : fieldOf(message.message_reference, "message_id") === replyTo
      return answers ? [id] : []
    })
    .sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))
}
