import { parseBounds } from "../chats/bounds"
import { UNTRUSTED_NOTE } from "../chats/format"
import { reactionsNote } from "../chats/message-items"
import type { RequestOptions } from "../discord/client"
import { ingestChannels, ingestMessages } from "../discord/ingest"
import { SEARCH_LIMIT_DEFAULT } from "./args"
import { discordPage } from "./discord-page"
import { itemsOf, rowsOfIds } from "./items"
import type { SearchMessageItem, SearchHandler, SearchReadInput } from "./schemas"
import { type DiscordScope, discordScope } from "./scope"

/** What the result of a search of Discord tells about its reach, its paging and what was stored. */
const DISCORD_NOTE =
  "Discord's own search found these, and they were stored in the local mirror (reaction counts are not part of its results). Its pages can come back short: keep paging with `before` set to `next_before` until a page is empty. `total` is Discord's estimate."

/** How Discord's search orders its hits. */
const SORT_BY = "timestamp"
const SORT_ORDER = "desc"

/** The lower bound `parseBounds` gives for an `after` before Discord's first id: no bound at all. */
const NO_LOWER_BOUND = "0"

/** The terms of one search, as Discord takes them: a query string for a server or a DM, the `messages` tab for every DM. */
type Terms = NonNullable<RequestOptions["query"]>

/** The terms the arguments describe; a term the arguments leave out is absent. */
function termsOf(args: SearchReadInput, limit: number): Terms {
  const { before, after } = parseBounds(args.before, args.after)
  return {
    content: args.query,
    author_id: args.author === undefined ? undefined : [args.author],
    mentions: args.mentions === undefined ? undefined : [args.mentions],
    has: args.has,
    pinned: args.pinned,
    max_id: before,
    min_id: after === NO_LOWER_BOUND ? undefined : after,
    limit,
    sort_by: SORT_BY,
    sort_order: SORT_ORDER,
  }
}

/** The request for `scope`: a query for a server or a DM, a body for every DM. */
function requestOf(scope: DiscordScope, terms: Terms): { method: "GET" | "POST"; options: RequestOptions } {
  if (scope.kind === "tabs") {
    return {
      method: "POST",
      options: {
        referer: scope.referer,
        body: { tabs: { messages: { ...terms, cursor: null } }, track_exact_total_hits: false },
      },
    }
  }
  return {
    method: "GET",
    options: {
      referer: scope.referer,
      query: {
        ...terms,
        channel_id: scope.channel,
        // Discord never overrides the account's own NSFW setting with it; DMs have no NSFW to include.
        include_nsfw: scope.kind === "guild" ? true : undefined,
      },
    },
  }
}

/** The smallest of the ids; `undefined` when there are none. */
function oldestId(ids: readonly string[]): string | undefined {
  return ids.reduce<string | undefined>(
    (oldest, id) => (oldest === undefined || BigInt(id) < BigInt(oldest) ? id : oldest),
    undefined,
  )
}

/**
 * Method `discord`: Discord's own search of a server, one chat, or every DM and
 * group DM, newest first, stored in the mirror and read back as `mirror` reads
 * it. The scope is checked against the mirror before any request. The hits are
 * not contiguous history: nothing is deleted, stored reactions are kept and no
 * chat is marked current. Discord's pages can be short, so `next_before` is the
 * oldest hit whenever the page held one.
 */
export const searchDiscord: SearchHandler = async (session, args) => {
  const scope = discordScope(session, args)
  const terms = termsOf(args, args.limit ?? SEARCH_LIMIT_DEFAULT)
  const { method, options } = requestOf(scope, terms)
  const value = await session.client().read(method, scope.path, {
    ...options,
    ...(session.signal ? { signal: session.signal } : {}),
  })
  const page = discordPage(value, scope, parseBounds(args.before, args.after).before)
  session.store((ctx) => {
    ingestChannels(session.mirror, ctx, page.threads, scope.server)
    // A hit found in a server is in that server, even in a chat the mirror does not know yet.
    const hits = page.hits.map((hit) =>
      scope.server === undefined || hit.guild_id != null ? hit : { ...hit, guild_id: scope.server },
    )
    ingestMessages(session.mirror, ctx, hits, { reactions: false })
  })
  const { messages, chats } = itemsOf(
    session,
    rowsOfIds(
      session,
      page.hits.map((hit) => hit.id as string),
    ),
  )
  // Paging follows Discord's page, not what the mirror stored of it, so a page whose hits were all skipped still moves back.
  const oldest = oldestId(page.hits.map((hit) => hit.id as string))
  return {
    source: "discord",
    note: `${DISCORD_NOTE} ${UNTRUSTED_NOTE}`,
    messages,
    chats,
    ...(page.total === undefined ? {} : { total: page.total }),
    ...(oldest === undefined ? {} : { next_before: oldest }),
    ...reactionsNote(messages),
  }
}
