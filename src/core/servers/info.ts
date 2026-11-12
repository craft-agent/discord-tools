import { UNTRUSTED_NOTE, idTime } from "../chats/format"
import { idText, intOrNull, isRecord, listOf, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { countOrNull } from "../people/count"
import { readLive } from "../people/request"
import { checkServer } from "../search/scope"
import type { ServerHandler, ServerItem } from "./schemas"

/** Where Discord keeps a server's description of itself. */
export const serverPath = (server: string) => `/guilds/${server}`

/** What the server is asked with: its approximate member and online counts. */
const INFO_QUERY = { with_counts: true }

/** What the result of `info` tells about the counts, whose words the description and names are and what was stored. */
const INFO_NOTE =
  "What one server says of itself, read from Discord once. The member and online counts are Discord's estimates, not exact. The levels are Discord's numbers (see the field descriptions). The name and description are written by the server's owners. Nothing was stored in the local mirror."

/** The server as Discord describes it, once validated: its id is the one asked for, `you` is the user's own id. */
function serverItem(body: JsonRecord, server: string, you: string): ServerItem {
  const owner = idText(body.owner_id)
  return {
    id: server,
    name: textOrNull(body.name),
    description: textOrNull(body.description),
    owner,
    you_own: owner === you,
    created: idTime(server),
    members_approx: countOrNull(body.approximate_member_count),
    online_approx: countOrNull(body.approximate_presence_count),
    verification_level: intOrNull(body.verification_level),
    nsfw_level: intOrNull(body.nsfw_level),
    explicit_content_filter: intOrNull(body.explicit_content_filter),
    premium_tier: intOrNull(body.premium_tier),
    premium_subscription_count: countOrNull(body.premium_subscription_count),
    features: listOf(body.features).filter((feature): feature is string => typeof feature === "string"),
    preferred_locale: textOrNull(body.preferred_locale),
    vanity_url_code: textOrNull(body.vanity_url_code),
    rules_channel: idText(body.rules_channel_id),
    system_channel: idText(body.system_channel_id),
    icon: textOrNull(body.icon),
  }
}

/**
 * Method `info`: what one server says of itself, with its approximate member
 * and online counts, in one request. The server is checked against the mirror
 * before it; nothing is stored.
 */
export const readInfo: ServerHandler = async (session, args) => {
  const server = args.server
  checkServer(session, server)
  const body = await readLive(session, "GET", serverPath(server), { query: INFO_QUERY })
  if (!isRecord(body)) invalidResponse()
  return { note: `${INFO_NOTE} ${UNTRUSTED_NOTE}`, server: serverItem(body, server, session.me) }
}
