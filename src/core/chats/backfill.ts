import { isAbortError, isToolError, ToolError } from "../errors"
import { ingestOlderHistory } from "../discord/ingest"
import { getCursor } from "../discord/mirror-cursors"
import { historyPage } from "../discord/sync-page"
import { BACKFILL_PAGES_DEFAULT } from "./args"
import { knownChannel } from "./channel-target"
import { idTime } from "./format"
import { checkAbort, type ChatHandler, type ChatSession } from "./session"

/** How many messages one `backfill` request asks Discord for; Discord's page maximum. */
export const BACKFILL_PAGE_SIZE = 100

/** The stored cursor of a chat the sync follows; `invalid_argument` for any other chat or one the sync has not filled yet. */
function followedCursor(session: ChatSession, channel: string) {
  const cursor = getCursor(session.mirror, channel)
  if (!cursor) {
    throw new ToolError(
      "invalid_argument",
      "backfill is for chats the sync follows; read older messages with method messages and before.",
    )
  }
  if (cursor.oldest === null && !cursor.complete) {
    throw new ToolError("invalid_argument", "the sync has not stored this chat's history yet.")
  }
  return cursor
}

/**
 * Pulls older history of a chat the sync follows into the local mirror, up to
 * `pages` pages of `BACKFILL_PAGE_SIZE` messages back from the cursor's oldest
 * edge. Each page is stored, widening the vouched range, before the next
 * request. A failure on the first page throws; on a later page it ends the
 * paging and is reported in `stopped`. Never marks the channel current.
 */
export const readBackfill: ChatHandler = async (session, args) => {
  const target = knownChannel(session, args)
  const channel = target.id
  const pages = args.pages ?? BACKFILL_PAGES_DEFAULT
  let cursor = followedCursor(session, channel)
  let requests = 0
  let stored = 0
  let deleted = 0
  let stopped: { code: string; message: string } | null = null

  while (requests < pages && !cursor.complete) {
    checkAbort(session.signal)
    const before = cursor.oldest!
    const firstPage = requests === 0
    requests += 1
    try {
      const value = await session.client().read("GET", `/channels/${channel}/messages`, {
        query: { limit: BACKFILL_PAGE_SIZE, before },
        referer: target.referer,
        ...(session.signal ? { signal: session.signal } : {}),
      })
      const page = historyPage(value, channel, BACKFILL_PAGE_SIZE, before)
      const counts = session.store((ctx) => ingestOlderHistory(session.mirror, ctx, channel, page))
      stored += counts.stored
      deleted += counts.deleted
    } catch (error) {
      if (firstPage || isAbortError(error) || session.signal?.aborted || !isToolError(error)) throw error
      stopped = { code: error.code, message: error.message }
      break
    }
    cursor = getCursor(session.mirror, channel) ?? cursor
  }

  return {
    source: "live",
    channel,
    pages: requests,
    stored,
    deleted,
    complete: cursor.complete,
    oldest: cursor.oldest,
    oldest_at: cursor.oldest === null ? null : idTime(cursor.oldest),
    stopped,
  }
}
