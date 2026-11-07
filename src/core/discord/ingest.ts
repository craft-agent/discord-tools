/**
 * The one ingest every write to the mirror goes through. Each function runs in
 * the caller's transaction and never opens one, skips an entry that is not
 * shaped as documented (counting it), throws only when the database fails, and
 * returns counts, never content.
 */
export { ingestChannels, ingestDmList } from "./ingest-channels"
export type { IngestContext, IngestCounts } from "./ingest-context"
export { deleteMessage, ingestHistoryPage, ingestOlderHistory } from "./ingest-history"
export { ingestMessages } from "./ingest-messages"
export { emojiKey } from "./ingest-parts"
export { ingestServerList, ingestServers } from "./ingest-servers"
export { ingestUsers } from "./ingest-users"
