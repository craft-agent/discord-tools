import { ToolError } from "../errors"
import { isSnowflake } from "../discord/snowflake"
import type { ChatMethod, ChatReadInput } from "./schemas"

/** How many chats `dms` returns when `limit` is left out. */
export const DMS_LIMIT_DEFAULT = 30

/** The most chats `dms` returns in one call. */
export const DMS_LIMIT_MAX = 200

/** The arguments every method takes. */
const ALWAYS: readonly (keyof ChatReadInput)[] = ["account", "method"]

/** The arguments each method takes besides `ALWAYS`; a method is added here as well as to `CHAT_METHODS`. */
const ALLOWED: Record<ChatMethod, readonly (keyof ChatReadInput)[]> = {
  servers: ["refresh"],
  channels: ["server"],
  dms: ["query", "limit", "offset"],
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

/**
 * Refuses what the method cannot use, before anything is opened: an argument
 * the method does not take, a missing required one, an id that is not a
 * snowflake and a `limit` over the method's maximum.
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
}
