import { ToolError } from "../errors"
import { CATEGORY_TYPE } from "../chats/channels"
import { mirroredChannelId } from "../chats/channel-target"
import { channelKind } from "../chats/format"
import type { ChatSession } from "../chats/session"
import type { SearchReadInput } from "./schemas"

/** The `referer` page of the DM list, where a search of every DM comes from. */
const DMS_REFERER = "/channels/@me"

/** Where `discord_search_read` method `discord` asks, and what it needs to ask there. */
export type DiscordScope = {
  /** `guild`: a server or one chat of it; `dm`: one DM or group DM; `tabs`: every DM and group DM. */
  kind: "guild" | "dm" | "tabs"
  path: string
  referer: string
  /** The server a `guild` search asks in. */
  server?: string
  /** The one chat of a `guild` search. */
  channel?: string
}

/** The server the mirror knows; `not_found` otherwise. */
export function checkServer(session: Pick<ChatSession, "mirror">, server: string): void {
  if (!session.mirror.prepare("SELECT 1 FROM servers WHERE id = ?").get(BigInt(server))) {
    throw new ToolError(
      "not_found",
      `This account has no server ${server} in its mirror: list its servers with discord_chat_read method servers first.`,
    )
  }
}

/**
 * The place Discord's search is asked, from `channel` or `server` as the mirror
 * knows them; nothing is requested. `not_found` for one the mirror does not
 * know, `invalid_argument` for a category, forum or media channel, which Discord
 * cannot search as a whole. Neither argument means every DM and group DM.
 */
export function discordScope(session: ChatSession, args: SearchReadInput): DiscordScope {
  if (args.channel !== undefined) {
    const { target, type, server } = mirroredChannelId(session, args.channel)
    const kind = channelKind(type)
    if (type === CATEGORY_TYPE) {
      throw new ToolError(
        "invalid_argument",
        `Channel ${target.id} is a category and holds no messages: search a channel under it, or its server.`,
      )
    }
    if (kind === "forum" || kind === "media") {
      throw new ToolError(
        "invalid_argument",
        `Channel ${target.id} is a ${kind} channel and holds no messages of its own: Discord's search takes its posts by their own ids (find them with discord_chat_read method threads), or use method mirror with threads true.`,
      )
    }
    if (server === null) {
      return { kind: "dm", path: `/channels/${target.id}/messages/search`, referer: target.referer }
    }
    return {
      kind: "guild",
      path: `/guilds/${server}/messages/search`,
      referer: target.referer,
      server,
      channel: target.id,
    }
  }
  if (args.server !== undefined) {
    checkServer(session, args.server)
    return {
      kind: "guild",
      path: `/guilds/${args.server}/messages/search`,
      referer: `/channels/${args.server}`,
      server: args.server,
    }
  }
  return { kind: "tabs", path: "/users/@me/messages/search/tabs", referer: DMS_REFERER }
}
