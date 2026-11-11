import { openChatSession } from "../chats/session"
import { setCursorEdges } from "../discord/mirror-cursors"
import { CHANNEL, msgId } from "../discord/objects.testing"
import { said, store } from "../search/search.testing"
import { type ExportRange, type ExportSelection, selectExport } from "./export-select"
import type { HistoryFixture } from "./history.testing"

/** Runs `selectExport` over a session of the fixture's label, which it closes again. */
export async function selectIn(f: HistoryFixture, range: ExportRange): Promise<ExportSelection> {
  const session = await openChatSession({}, f.ctx)
  try {
    return selectExport(session, range)
  } finally {
    session.close()
  }
}

/** Stores the messages `msgId(n)` of `channel` for each `n`, written by Alice. */
export function storeMessages(f: HistoryFixture, numbers: readonly number[], channel = CHANNEL): void {
  store(f, ...numbers.map((n) => said(channel, n)))
}

/** Records that the mirror holds `channel` from `msgId(oldest)` to `msgId(newest)`, to its first message when `complete`. */
export function vouch(f: HistoryFixture, channel: string, oldest: number, newest: number, complete = false): void {
  f.seed((m) => setCursorEdges(m, channel, { oldest: msgId(oldest), newest: msgId(newest), complete }))
}
