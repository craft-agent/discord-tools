/** What an ingest call needs to know about the account and the moment. */
export type IngestContext = {
  /** The signed-in user's id, so a message knows whether it is the user's own. */
  me: string
  /** The time of the call, in milliseconds. */
  now: number
}

/** What an ingest call did, as counts for a log and never content. */
export type IngestCounts = {
  /** Entries written to the mirror. */
  stored: number
  /** Rows removed from the mirror. */
  deleted: number
  /** Entries left out because they were not shaped as documented. */
  skipped: number
}

/** A fresh `IngestCounts` of zeros. */
export function newCounts(): IngestCounts {
  return { stored: 0, deleted: 0, skipped: 0 }
}
