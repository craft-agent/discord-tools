import { headerOf, type FakeAnswer, type RecordedRequest } from "../discord/fake-discord.testing"
import { SERVER } from "../discord/objects.testing"
import { WEB_ORIGIN } from "../discord/request-headers"
import { said, type SearchFixture } from "./search.testing"

/** The paths of Discord's search of `SERVER`, of every DM, and of one chat. */
export const GUILD_SEARCH = `/guilds/${SERVER}/messages/search`
export const TABS_SEARCH = "/users/@me/messages/search/tabs"
export const chatSearch = (channel: string) => `/channels/${channel}/messages/search`

/** A message as a search answers with it: marked as a hit. */
export const found = (channel: string, n: number, extra: Record<string, unknown> = {}) => ({
  ...said(channel, n),
  hit: true,
  ...extra,
})

/** The answer of a search of a server or a DM: one group for each message. */
export const answer = (groups: unknown[], extra: Record<string, unknown> = {}): FakeAnswer => ({
  status: 200,
  json: { messages: groups, total_results: groups.length, ...extra },
})

/** The answer of the search of every DM. */
export const tabsAnswer = (groups: unknown[], extra: Record<string, unknown> = {}): FakeAnswer => ({
  status: 200,
  json: { tabs: { messages: { messages: groups, total_results: groups.length, cursor: null, ...extra } } },
})

/** Runs `discord_search_read` method `discord`. */
export const searchDiscord = (f: SearchFixture, args: Record<string, unknown> = {}) =>
  f.search({ method: "discord", query: "text", ...args })

/** The requests the fake received for a search of `path`. */
export const sentTo = (f: SearchFixture, path: string): RecordedRequest[] =>
  f.discord.api.filter((request) => request.path === path)

/** The page a request says it comes from. */
export const refererOf = (request: RecordedRequest) => headerOf(request, "referer")?.slice(WEB_ORIGIN.length)

/** The query of a request, each key with all its values. */
export const queryOf = (request: RecordedRequest): Record<string, string[]> => {
  const query: Record<string, string[]> = {}
  for (const key of new Set(request.query.keys())) query[key] = request.query.getAll(key)
  return query
}
