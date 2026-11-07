import { ingestServerList } from "../discord/ingest"
import { SERVER_LIST_AT_META } from "../discord/mirror-meta"
import { readSyncList } from "../discord/sync-list"
import { idRecords } from "../discord/sync-page"
import { freshStamp, listStamp } from "./lists"
import type { ServerItem } from "./schemas"
import type { ChatHandler } from "./session"

/** How long the mirror serves the server list: servers change rarely and a sync run refreshes them only when the sync list names one. */
export const SERVER_LIST_MS = 6 * 60 * 60 * 1000

type ServerRow = { id: string; name: string | null; owner: number | null }

/** Method `servers`: the servers the latest full list held, from the mirror while it is recent, else from Discord. */
export const readServers: ChatHandler = async (session, args) => {
  const fresh = freshStamp(session, SERVER_LIST_AT_META, SERVER_LIST_MS, args.refresh === true)
  if (fresh === null) {
    const servers = idRecords(
      await session.client().read("GET", "/users/@me/guilds", {
        query: { with_counts: "false" },
        ...(session.signal ? { signal: session.signal } : {}),
      }),
    )
    session.store((ctx) => ingestServerList(session.mirror, ctx, servers))
  }
  const since = fresh ?? listStamp(session, SERVER_LIST_AT_META) ?? 0
  const rows = session.mirror
    .prepare("SELECT CAST(id AS TEXT) AS id, name, owner FROM servers WHERE updated >= ? ORDER BY lower(name), id")
    .all(since) as ServerRow[]
  const followed = new Map((await readSyncList(session.paths)).servers.map((entry) => [entry.id, entry]))
  const servers: ServerItem[] = rows.map((row) => {
    const entry = followed.get(row.id)
    return {
      id: row.id,
      name: row.name,
      owner: row.owner === null ? null : row.owner === 1,
      followed: entry ? (entry.channels ? "channels" : "server") : null,
    }
  })
  return { source: fresh === null ? "live" : "mirror", servers }
}
