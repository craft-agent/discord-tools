import { userLookup } from "../chats/dms"
import { UNTRUSTED_NOTE, displayName } from "../chats/format"
import { ingestUsers } from "../discord/ingest"
import { fieldOf, idText, isRecord, listOf, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { checkServer } from "../search/scope"
import { countOrNull } from "./count"
import { checkUser, serverNameLookup } from "./known"
import { memberFields } from "./member-fields"
import { byNameThenId } from "./order"
import { explainRefusal, readLive } from "./request"
import type { PeopleHandler, ProfileItem } from "./schemas"

/** Where Discord keeps a person's profile. */
export const profilePath = (user: string) => `/users/${user}/profile`

/** What the profile of a person is asked with: their mutual servers and friends, counted too. */
const PROFILE_QUERY = { with_mutual_guilds: true, with_mutual_friends: true, with_mutual_friends_count: true }

/** What Discord's refusal to show a profile means, said ahead of Discord's own message. */
const PROFILE_REFUSED =
  "Discord shows a profile only to a friend, someone who shares a server with the user, a bot or someone with a pending friend request, and did not show this one."

/** What the result of `profile` tells about whose words they are and what was stored. */
const PROFILE_NOTE =
  "One person's profile, read from Discord once. The bio, pronouns and connected account names are the person's own words; role names are not resolved here (use method member). Mutual servers are named from the local mirror (null when it does not hold one). Nothing but user names was stored in the local mirror."

/** The accounts a profile lists, once validated: those with a service and a name. */
function connectedAccounts(value: unknown): ProfileItem["connected_accounts"] {
  return listOf(value).flatMap((entry) => {
    const type = textOrNull(fieldOf(entry, "type"))
    const name = textOrNull(fieldOf(entry, "name"))
    return type === null || name === null ? [] : [{ type, name, verified: fieldOf(entry, "verified") === true }]
  })
}

/** The servers a profile lists as shared, those with a valid id, named from the mirror. */
function mutualServers(value: unknown, nameOf: (id: string) => string | null): ProfileItem["mutual_servers"] {
  return listOf(value).flatMap((entry) => {
    const id = idText(fieldOf(entry, "id"))
    return id === null ? [] : [{ id, name: nameOf(id), nick: textOrNull(fieldOf(entry, "nick")) }]
  })
}

/** The user objects of the mutual friends a profile lists, those with a valid id. */
function mutualFriendUsers(value: unknown): JsonRecord[] {
  return listOf(value).filter((entry): entry is JsonRecord => isRecord(entry) && idText(entry.id) !== null)
}

/** The mutual friends as items, ordered by name then id. */
function mutualFriends(users: readonly JsonRecord[]): ProfileItem["mutual_friends"] {
  return users
    .map((user) => {
      const id = user.id as string
      const username = textOrNull(user.username)
      return { id, name: displayName({ username, global_name: textOrNull(user.global_name) }) ?? id, username }
    })
    .sort(byNameThenId)
}

/** The person's membership of `server`, when one was asked for and Discord sent it. */
function membershipOf(body: JsonRecord, server: string | undefined): ProfileItem["member"] {
  const member = body.guild_member
  return server === undefined || !isRecord(member) ? null : { server, ...memberFields(member) }
}

/**
 * Method `profile`: one person's profile, with their mutual servers and
 * friends, and with `server` their membership there. The person and the server
 * are checked against the mirror before any request. Only the user objects
 * Discord returns are stored; the profile itself is not.
 */
export const readProfile: PeopleHandler = async (session, args) => {
  const user = args.user!
  checkUser(session, user)
  if (args.server !== undefined) checkServer(session, args.server)
  const body = await readLive(session, "GET", profilePath(user), {
    query: { ...PROFILE_QUERY, guild_id: args.server },
  }).catch((error: unknown) => explainRefusal(error, { forbidden: PROFILE_REFUSED, not_found: PROFILE_REFUSED }))
  if (!isRecord(body)) invalidResponse()
  const friendUsers = mutualFriendUsers(body.mutual_friends)
  session.store((ctx) => {
    ingestUsers(session.mirror, ctx, [...(isRecord(body.user) ? [body.user] : []), ...friendUsers])
  })
  const account = userLookup(session.mirror)(user)
  const details = isRecord(body.user_profile) ? body.user_profile : {}
  const profile: ProfileItem = {
    id: user,
    name: displayName(account) ?? user,
    username: account.username,
    bot: fieldOf(body.user, "bot") === true,
    bio: textOrNull(details.bio) ?? textOrNull(fieldOf(body.user, "bio")),
    pronouns: textOrNull(details.pronouns),
    connected_accounts: connectedAccounts(body.connected_accounts),
    mutual_servers: mutualServers(body.mutual_guilds, serverNameLookup(session.mirror)),
    mutual_friends: mutualFriends(friendUsers),
    mutual_friends_count: countOrNull(body.mutual_friends_count),
    member: membershipOf(body, args.server),
  }
  return { note: `${PROFILE_NOTE} ${UNTRUSTED_NOTE}`, profile }
}
