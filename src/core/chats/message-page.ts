import type { MessageBounds } from "./bounds"

/** The chat a message read is about. */
export type ChannelTarget = {
  id: string
  /** The page of the web client the request claims to come from. */
  referer: string
}

/** One `messages` read: which way it goes and what it keeps. */
export type MessageRequest = MessageBounds & {
  channel: ChannelTarget
  limit: number
  /** `forward` reads the oldest messages after `after`; `backward` the newest ones before `before`. */
  direction: "backward" | "forward"
}

/** The ids one source returned for a read, oldest first, and where to page on. */
export type MessagePage = {
  ids: string[]
  next_before: string | null
  next_after: string | null
}
