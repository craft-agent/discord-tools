/**
 * The one ingest every write to the mirror goes through. Each function runs in
 * the caller's transaction and never opens one, skips an entry that is not
 * shaped as documented (counting it), throws only when the database fails, and
 * returns counts, never content.
 */
export { ingestChannels } from "./ingest-channels"
export type { IngestContext, IngestCounts } from "./ingest-context"
export { ingestServers } from "./ingest-servers"
export { ingestUsers } from "./ingest-users"
