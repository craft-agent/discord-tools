export const SYNC_ME = "1001"
export const SYNC_CHANNEL = "2001"

/** A complete history entry, with deliberately made-up ids. */
export function syncMessage(id: string | number, channel = SYNC_CHANNEL, content = `message ${id}`) {
  return { id: String(id), channel_id: channel, content, author: { id: SYNC_ME, username: "tester" }, type: 0 }
}

/** Newest first, like the history endpoint. */
export function syncMessages(newest: number, oldest: number, channel = SYNC_CHANNEL) {
  return Array.from({ length: newest - oldest + 1 }, (_, index) => syncMessage(newest - index, channel))
}
