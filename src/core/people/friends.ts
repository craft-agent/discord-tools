import { DM_TYPE, recipientIds } from "../chats/dms"
import { UNTRUSTED_NOTE, displayName, isoOrNull } from "../chats/format"
import type { ChatSession } from "../chats/session"
import { ingestUsers } from "../discord/ingest"
import { idText, isRecord, textOrNull, timeOrNull, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { byNameThenId } from "./order"
import type { FriendItem, PeopleHandler } from "./schemas"

/** Where Discord lists the account's relationships: friends, pending requests and blocks. */
export const RELATIONSHIPS_PATH = "/users/@me/relationships"

/** The relationship types the list uses: a friend, a request received, a request sent. */
const FRIEND_TYPE = 1
const INCOMING_TYPE = 3
const OUTGOING_TYPE = 4

/** What the result of `friends` tells about whose list it is, what it leaves out and what was stored. */
const FRIENDS_NOTE =
  "The user's own friend list, from Discord: friends only, each with the nickname the user gave them and the id of the DM with them that the local mirror already holds (null when it holds none; no DM was opened). `requests` counts pending friend requests without saying who they are from or to; blocked users are left out. Only the friends' user names were stored in the local mirror."

/** One friend of Discord's list, once validated. */
type Friend = { id: string; user: JsonRecord | undefined; nickname: string | null; since: string | null }

/**
 * Validates Discord's relationship list: an array of objects, else
 * `upstream_error`. Friends (a valid id each, repeats left out) are kept;
 * requests are counted by direction; blocks and any other type are ignored.
 */
function relationshipsOf(value: unknown): { friends: Friend[]; incoming: number; outgoing: number } {
  if (!Array.isArray(value)) invalidResponse()
  const friends = new Map<string, Friend>()
  let incoming = 0
  let outgoing = 0
  for (const entry of value) {
    if (!isRecord(entry)) invalidResponse()
    if (entry.type === INCOMING_TYPE) incoming += 1
    else if (entry.type === OUTGOING_TYPE) outgoing += 1
    else if (entry.type === FRIEND_TYPE) {
      const id = idText(entry.id)
      if (id === null) invalidResponse()
      if (friends.has(id)) continue
      friends.set(id, {
        id,
        user: isRecord(entry.user) ? entry.user : undefined,
        nickname: textOrNull(entry.nickname),
        since: isoOrNull(timeOrNull(entry.since)),
      })
    }
  }
  return { friends: [...friends.values()], incoming, outgoing }
}

/** The id of the DM each user has with the user, from the DMs the mirror holds whose only recipient they are. */
function dmsByUser(session: ChatSession): Map<string, string> {
  const rows = session.mirror
    .prepare("SELECT CAST(id AS TEXT) AS id, recipients FROM channels WHERE type = ? ORDER BY id")
    .all(DM_TYPE) as { id: string; recipients: string | null }[]
  const dms = new Map<string, string>()
  for (const row of rows) {
    const recipients = recipientIds(row.recipients)
    if (recipients.length === 1) dms.set(recipients[0]!, row.id)
  }
  return dms
}

/** Whether any of the friend's names contains `query`, which is lower case. */
function matches(friend: FriendItem, query: string): boolean {
  return [friend.name, friend.username, friend.nickname].some((name) => name?.toLowerCase().includes(query))
}

/**
 * Method `friends`: the user's friends, from the one list Discord gives, and
 * how many requests are pending. The friends' user objects are stored in the
 * mirror; nothing else is, and no DM is opened.
 */
export const readFriends: PeopleHandler = async (session, args) => {
  const value = await session.client().read("GET", RELATIONSHIPS_PATH, session.signal ? { signal: session.signal } : {})
  const { friends, incoming, outgoing } = relationshipsOf(value)
  session.store((ctx) => {
    ingestUsers(
      session.mirror,
      ctx,
      friends.flatMap(({ user }) => user ?? []),
    )
  })
  const dms = dmsByUser(session)
  const all = friends
    .map(({ id, user, nickname, since }): FriendItem => {
      const username = textOrNull(user?.username)
      return {
        id,
        name: displayName({ username, global_name: textOrNull(user?.global_name) }) ?? id,
        username,
        nickname,
        since,
        dm: dms.get(id) ?? null,
      }
    })
    .sort(byNameThenId)
  const query = args.query?.toLowerCase()
  const shown = query === undefined ? all : all.filter((friend) => matches(friend, query))
  return {
    note: `${FRIENDS_NOTE} ${UNTRUSTED_NOTE}`,
    friends: shown,
    count: shown.length,
    total: all.length,
    requests: { incoming, outgoing },
  }
}
