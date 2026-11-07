/** The mirror's `meta` key that holds the id of the signed-in user, so `from_me` and later tools know who "me" is. */
export const ACCOUNT_ID_META = "account_id"

/** The `meta` key that holds when (ms) the server list was last read in full; servers stored since then are the ones it held. */
export const SERVER_LIST_AT_META = "server_list_at"

/** The `meta` key that holds when (ms) the DM list was last read in full; DMs and group DMs stored since then are the ones it held. */
export const DM_LIST_AT_META = "dm_list_at"
