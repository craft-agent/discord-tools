import { ToolError } from "../errors"
import { requireChannel } from "./args"
import { CATEGORY_TYPE } from "./channels"
import { channelKind } from "./format"
import type { ChannelTarget } from "./message-page"
import type { ChatReadInput } from "./schemas"
import type { ChatSession } from "./session"

type ChannelRow = { type: number; server: string | null; forum: string | null }

/** A channel the mirror knows: where to read it, what it is and, for a forum or media channel, its stored tags and sort as JSON. */
export type MirroredChannel = { target: ChannelTarget; type: number; server: string | null; forum: string | null }

/** The `referer` page of a chat that belongs to no server. */
const PRIVATE_REFERER_SERVER = "@me"

/** The channel the `channel` argument names, whatever its kind; `not_found` when the mirror has no such channel. */
export function mirroredChannel(session: ChatSession, args: ChatReadInput): MirroredChannel {
  const id = requireChannel(args)
  const row = session.mirror
    .prepare("SELECT type, CAST(server AS TEXT) AS server, forum FROM channels WHERE id = ?")
    .get(BigInt(id)) as ChannelRow | undefined
  if (!row) {
    throw new ToolError(
      "not_found",
      `This account has no channel ${id} in its mirror: find it with method dms, channels or threads first.`,
    )
  }
  return {
    target: { id, referer: `/channels/${row.server ?? PRIVATE_REFERER_SERVER}/${id}` },
    type: row.type,
    server: row.server,
    forum: row.forum,
  }
}

/**
 * The chat the `channel` argument names, as the mirror knows it. `not_found`
 * when the mirror has no such channel; `invalid_argument` for a category, a
 * forum or a media channel, which hold no messages of their own (a forum's
 * posts are threads).
 */
export function knownChannel(session: ChatSession, args: ChatReadInput): ChannelTarget {
  const { target, type } = mirroredChannel(session, args)
  const kind = channelKind(type)
  if (type === CATEGORY_TYPE || kind === "forum" || kind === "media") {
    const message =
      type === CATEGORY_TYPE
        ? "a category and holds no messages: read a channel under it."
        : `a ${kind} channel and holds no messages of its own: its posts are threads, so read one with its own id.`
    throw new ToolError("invalid_argument", `Channel ${target.id} is ${message}`)
  }
  return target
}
