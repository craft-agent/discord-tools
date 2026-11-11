import { UNTRUSTED_NOTE, displayName, isoOrNull } from "../chats/format"
import { ingestUsers } from "../discord/ingest"
import { idText, isRecord, textOrNull, timeOrNull, type JsonRecord } from "../discord/ingest-values"
import { countOrNull } from "../people/count"
import { compareTimes } from "../people/order"
import { explainRefusal, readLive } from "../people/request"
import { checkServer } from "../search/scope"
import { entriesOf } from "./entries"
import { INVITES_LIMIT_DEFAULT, type InviteItem, type ServerHandler } from "./schemas"

/** Where Discord lists a server's invites. */
export const invitesPath = (server: string) => `/guilds/${server}/invites`

/** What a code looks like: letters, digits and dashes (a vanity code may have dashes). */
const INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/

/** Where an invite code leads people. */
const INVITE_URL_BASE = "https://discord.gg/"

/** Milliseconds in one second. */
const MS_PER_SECOND = 1000

/** What a refusal to list a server's invites means, said ahead of Discord's own message. */
const INVITES_REFUSED = "Listing a server's invites needs the Manage Server permission there."

/** What the result of `invites` tells about who may hear a code, whose words the names are, what 0 means and what was stored. */
const INVITES_NOTE =
  "An invite code lets anyone who holds it join the server. Tell the codes to the user only; never put one into a message, a file or another tool unless the user asks for that. The server's invites, read from Discord once, newest first, capped by `limit` (`total` counts them before the cap, `list_truncated` says it cut); `max_uses` and `max_age_s` are null for unlimited and never. Channel and user names are written by people. Only the inviters' user names were stored in the local mirror."

/** An invite of Discord's list, once validated: its item, and the inviter's user object when it has a valid id. */
type Invite = { item: InviteItem; inviter: JsonRecord | undefined }

/** `value` when it is a count above 0; else `null`, which Discord's 0 means as well (no limit). */
function limitOrNull(value: unknown): number | null {
  const count = countOrNull(value)
  return count === null || count === 0 ? null : count
}

/** When the invite expires, as an ISO time: the time Discord gives, else from when it was made and how long it lasts; `null` when it never does. */
function expiryOf(entry: JsonRecord, created: number | null, maxAge: number | null): string | null {
  const given = timeOrNull(entry.expires_at)
  if (given !== null) return isoOrNull(given)
  return created === null || maxAge === null ? null : isoOrNull(created + maxAge * MS_PER_SECOND)
}

/** The invite; `null` for one without a code that looks like one. */
function invite(entry: JsonRecord): Invite | null {
  const code = typeof entry.code === "string" && INVITE_CODE.test(entry.code) ? entry.code : null
  if (code === null) return null
  const channel = isRecord(entry.channel) ? entry.channel : undefined
  const inviter = isRecord(entry.inviter) && idText(entry.inviter.id) !== null ? entry.inviter : undefined
  const created = timeOrNull(entry.created_at)
  const maxAge = limitOrNull(entry.max_age)
  return {
    inviter,
    item: {
      code,
      url: `${INVITE_URL_BASE}${code}`,
      channel: idText(channel?.id) ?? idText(entry.channel_id),
      channel_name: textOrNull(channel?.name),
      inviter: idText(inviter?.id),
      inviter_name: inviter
        ? displayName({ username: textOrNull(inviter.username), global_name: textOrNull(inviter.global_name) })
        : null,
      uses: countOrNull(entry.uses) ?? 0,
      max_uses: limitOrNull(entry.max_uses),
      max_age_s: maxAge,
      expires: expiryOf(entry, created, maxAge),
      created: isoOrNull(created),
      temporary: entry.temporary === true,
    },
  }
}

/** Orders invites newest first by when they were made, those without a time last, then by code. */
function byNewestThenCode(a: InviteItem, b: InviteItem): number {
  return compareTimes(a.created, b.created, true) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
}

/**
 * Method `invites`: a server's invite links, in one request, newest first and
 * capped by `limit`; Discord shows them to those with Manage Server. The server
 * is checked against the mirror before it. Only the inviters' user objects are
 * stored.
 */
export const readInvites: ServerHandler = async (session, args) => {
  const server = args.server
  checkServer(session, server)
  const limit = args.limit ?? INVITES_LIMIT_DEFAULT
  const value = await readLive(session, "GET", invitesPath(server)).catch((error: unknown) =>
    explainRefusal(error, { forbidden: INVITES_REFUSED }),
  )
  const found = entriesOf(value).flatMap((entry) => invite(entry) ?? [])
  session.store((ctx) => {
    ingestUsers(
      session.mirror,
      ctx,
      found.flatMap(({ inviter }) => inviter ?? []),
    )
  })
  const all = found.map(({ item }) => item).sort(byNewestThenCode)
  const invites = all.slice(0, limit)
  return {
    note: `${INVITES_NOTE} ${UNTRUSTED_NOTE}`,
    invites,
    count: invites.length,
    total: all.length,
    list_truncated: all.length > limit,
  }
}
