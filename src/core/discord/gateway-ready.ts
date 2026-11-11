import { ToolError } from "../errors"
import { fieldOf, idText, intOrNull, isRecord } from "./ingest-values"

/** `read_state_type` of a channel's read state; the other types (server, notification centre, …) are not channels. */
const CHANNEL_READ_STATE = 0

/** The read state of one channel, as Discord's READY holds it. */
export type ReadStateEntry = {
  /** The channel's id. */
  channel: string
  /** The last message read, or null when Discord named none. */
  lastRead: string | null
  /** Mentions not yet read. */
  mentions: number
  /** Discord's flags of the read state. */
  flags: number
}

/** What a gateway session read from READY. */
export type GatewayReady = {
  /** The account's id. */
  userId: string
  /** The channels' read states; other kinds are left out. */
  readStates: ReadStateEntry[]
  /** Whether Discord sent only part of the read states. */
  partial: boolean
  /** Milliseconds from sending the upgrade to READY. */
  ms: number
}

function entryOf(value: unknown): ReadStateEntry | undefined {
  const channel = idText(fieldOf(value, "id"))
  if (channel === null) return undefined
  if ((fieldOf(value, "read_state_type") ?? CHANNEL_READ_STATE) !== CHANNEL_READ_STATE) return undefined
  return {
    channel,
    lastRead: idText(fieldOf(value, "last_message_id")),
    mentions: Math.max(0, intOrNull(fieldOf(value, "mention_count")) ?? 0),
    flags: intOrNull(fieldOf(value, "flags")) ?? 0,
  }
}

/** Reads the `d` of a READY dispatch; `upstream_error` when it lacks the account or the read state. */
export function parseReady(data: unknown): Omit<GatewayReady, "ms"> {
  const userId = idText(fieldOf(fieldOf(data, "user"), "id"))
  const state = fieldOf(data, "read_state")
  const entries = fieldOf(state, "entries")
  if (userId === null || !isRecord(state) || !Array.isArray(entries)) {
    throw new ToolError("upstream_error", "Discord's gateway sent a READY without the account or its read state.")
  }
  return {
    userId,
    readStates: entries.flatMap((entry) => entryOf(entry) ?? []),
    partial: state.partial === true,
  }
}
