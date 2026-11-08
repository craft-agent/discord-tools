import { MAX_SYNC_CHANNELS, MAX_SYNC_SERVERS, readSyncList, WHOLE_SERVER_CHANNELS } from "../discord/sync-list"
import type { SyncHandler } from "./session"
import { addSuggestions } from "./suggest-add"
import { removeSuggestions } from "./suggest-remove"
import { SUGGEST_LIMIT_DEFAULT } from "./suggest-schemas"
import { suggestWindow } from "./suggest-window"

/** Method `suggest`: channels to add and entries to remove, from the local mirror alone; nothing is written. */
export const readSuggest: SyncHandler = async (session, args) => {
  const { servers } = await readSyncList(session.paths)
  const window = suggestWindow(args.after, session.now())
  const limit = args.limit ?? SUGGEST_LIMIT_DEFAULT
  return {
    since: window.since,
    add: addSuggestions(session, servers, window, limit),
    remove: removeSuggestions(session, servers, window, limit),
    room: {
      servers: { used: servers.length, max: MAX_SYNC_SERVERS },
      channels: {
        used: servers.reduce((sum, entry) => sum + (entry.channels?.length ?? WHOLE_SERVER_CHANNELS), 0),
        max: MAX_SYNC_CHANNELS,
      },
    },
  }
}
