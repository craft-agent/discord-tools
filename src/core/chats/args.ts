import { ToolError } from "../errors"
import { isSnowflake } from "../discord/snowflake"
import { parseBounds, parsePinTime } from "./bounds"
import type { ChatMethod, ChatReadInput } from "./schemas"

/** How many chats `dms` returns when `limit` is left out. */
export const DMS_LIMIT_DEFAULT = 30

/** The most chats `dms` returns in one call. */
export const DMS_LIMIT_MAX = 200

/** How many messages `messages` returns when `limit` is left out. */
export const MESSAGES_LIMIT_DEFAULT = 50

/** The most messages `messages` returns in one call. */
export const MESSAGES_LIMIT_MAX = 100

/** How many messages `around` returns on each side of the one asked for when `before_count` or `after_count` is left out. */
export const AROUND_COUNT_DEFAULT = 5

/** The most messages `around` returns on each side of the one asked for. */
export const AROUND_COUNT_MAX = 50

/** How many threads `threads` returns when `limit` is left out. */
export const THREADS_LIMIT_DEFAULT = 25

/** The most threads `threads` returns in one call. */
export const THREADS_LIMIT_MAX = 25

/** The largest `offset` of `threads`; Discord's thread search reaches no deeper. */
export const THREADS_OFFSET_MAX = 9975

/** How many pins `pins` returns when `limit` is left out. */
export const PINS_LIMIT_DEFAULT = 50

/** The most pins `pins` returns in one call. */
export const PINS_LIMIT_MAX = 50

/** The arguments every method takes. */
const ALWAYS: readonly (keyof ChatReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `CHAT_METHODS`. */
const ALLOWED: Record<ChatMethod, readonly (keyof ChatReadInput)[]> = {
  servers: ["refresh"],
  channels: ["server"],
  dms: ["query", "limit", "offset"],
  messages: ["channel", "before", "after", "limit", "live"],
  around: ["channel", "message", "before_count", "after_count"],
  threads: ["channel", "archived", "sort", "tag", "limit", "offset"],
  pins: ["channel", "before", "limit"],
}

function invalid(message: string): never {
  throw new ToolError("invalid_argument", message)
}

/** The `server` argument as a checked snowflake; `invalid_argument` when it is missing or not an id. */
export function requireServer(args: ChatReadInput): string {
  if (args.server === undefined)
    invalid(`Method ${args.method} needs \`server\`: the id of a server, from method servers.`)
  if (!isSnowflake(args.server)) invalid("`server` must be a server id: a number of up to 20 digits, not a name.")
  return args.server
}

/** The `channel` argument as a checked snowflake; `invalid_argument` when it is missing or not an id. */
export function requireChannel(args: ChatReadInput): string {
  if (args.channel === undefined) {
    invalid(`Method ${args.method} needs \`channel\`: the id of a chat, from method dms or channels.`)
  }
  if (!isSnowflake(args.channel)) invalid("`channel` must be a channel id: a number of up to 20 digits, not a name.")
  return args.channel
}

/** The `message` argument as a checked snowflake; `invalid_argument` when it is missing or not an id. */
export function requireMessage(args: ChatReadInput): string {
  if (args.message === undefined) invalid("Method around needs `message`: the id of the message to read around.")
  if (!isSnowflake(args.message)) invalid("`message` must be a message id: a number of up to 20 digits.")
  return args.message
}

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, a missing required one, an id that is not a
 * snowflake, a bound that is not an id, a date or a timestamp, and a `limit`
 * or count over the method's maximum.
 */
export function checkArgs(args: ChatReadInput): void {
  const takes = [...ALWAYS, ...ALLOWED[args.method]]
  for (const [field, value] of Object.entries(args)) {
    if (value !== undefined && !takes.includes(field as keyof ChatReadInput)) {
      invalid(`${field} is not an argument of method ${args.method}; it takes: ${takes.join(", ")}.`)
    }
  }
  if (args.method === "channels") requireServer(args)
  if (args.method === "dms" && args.limit !== undefined && args.limit > DMS_LIMIT_MAX) {
    invalid(`limit is at most ${DMS_LIMIT_MAX} for method dms.`)
  }
  if (args.method === "messages") {
    requireChannel(args)
    parseBounds(args.before, args.after)
    if (args.limit !== undefined && args.limit > MESSAGES_LIMIT_MAX) {
      invalid(`limit is at most ${MESSAGES_LIMIT_MAX} for method messages.`)
    }
  }
  if (args.method === "threads") {
    requireChannel(args)
    if (args.tag !== undefined && !isSnowflake(args.tag)) {
      invalid("`tag` must be a tag id: a number of up to 20 digits, from the `tags` of a forum, not a name.")
    }
    if (args.limit !== undefined && args.limit > THREADS_LIMIT_MAX) {
      invalid(`limit is at most ${THREADS_LIMIT_MAX} for method threads.`)
    }
    if (args.offset !== undefined && args.offset > THREADS_OFFSET_MAX) {
      invalid(`offset is at most ${THREADS_OFFSET_MAX} for method threads.`)
    }
  }
  if (args.method === "pins") {
    requireChannel(args)
    if (args.before !== undefined) parsePinTime(args.before)
    if (args.limit !== undefined && args.limit > PINS_LIMIT_MAX) {
      invalid(`limit is at most ${PINS_LIMIT_MAX} for method pins.`)
    }
  }
  if (args.method === "around") {
    requireChannel(args)
    requireMessage(args)
    for (const count of ["before_count", "after_count"] as const) {
      if ((args[count] ?? 0) > AROUND_COUNT_MAX) invalid(`${count} is at most ${AROUND_COUNT_MAX} for method around.`)
    }
  }
}
