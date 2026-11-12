import { storedTags } from "../chats/forum-tags"
import { channelKind } from "../chats/format"
import type { TagItem } from "../chats/thread-schemas"
import type { Mirror } from "../discord/mirror"
import { ToolError } from "../errors"
import type { PostCreateInput } from "./post-schemas"

/** The channel types a post goes in: forum and media. */
const POST_PARENT_TYPES: readonly number[] = [15, 16]

/** The channel flag of a forum that wants a tag on every post. */
const REQUIRE_TAG_FLAG = 1 << 4

/** What the mirror holds of a channel that a post depends on: its type, its stored tags as JSON and its flags. */
type ForumRow = { type: number; forum: string | null; flags: number | null }

/** The channel as the mirror holds it; `not_found` when it has no such channel. */
function forumRow(mirror: Mirror, channel: string): ForumRow {
  const row = mirror
    .prepare("SELECT type, forum, json_extract(raw, '$.flags') AS flags FROM channels WHERE id = ?")
    .get(BigInt(channel)) as ForumRow | undefined
  if (!row) {
    throw new ToolError(
      "not_found",
      `This account has no channel ${channel} in its mirror: find it with method dms, channels or threads first.`,
    )
  }
  return row
}

/** What a channel that cannot hold a post is, for the refusal. */
function refusedKind(type: number): string {
  const kind = channelKind(type)
  return kind === "text" || kind === "announcement"
    ? "a text or announcement channel, which takes a thread, not a post: start one with discord_thread_create"
    : "not a forum or media channel"
}

/** The tags a forum offers, as `id (name)`, for a refusal. */
const tagList = (tags: TagItem[]) => tags.map((tag) => `${tag.id} (${tag.name})`).join(", ") || "none"

/**
 * The tags of a post, as the mirror lists them for the forum, in the order
 * given (none when `tags` is left out). `not_found` when the mirror has no such
 * channel, or has no tag list for it while `tags` are given; `invalid_argument`
 * for a channel that is not a forum or media channel, a tag it does not list,
 * and no tag in a forum whose flags require one. The mirror alone is read.
 */
export function postTags(mirror: Mirror, { channel, tags }: Pick<PostCreateInput, "channel" | "tags">): TagItem[] {
  const row = forumRow(mirror, channel)
  if (!POST_PARENT_TYPES.includes(row.type)) {
    throw new ToolError(
      "invalid_argument",
      `Channel ${channel} is ${refusedKind(row.type)}. A post goes in a forum or media channel of a server the mirror knows: find one with discord_chat_read, method channels.`,
    )
  }
  const stored = storedTags(row.forum)
  if (tags === undefined) {
    if (((row.flags ?? 0) & REQUIRE_TAG_FLAG) !== 0) {
      throw new ToolError(
        "invalid_argument",
        `Channel ${channel} requires a tag on every post: pass \`tags\` with the id of one of its tags (${stored ? tagList(stored) : "list them with discord_chat_read, method threads"}).`,
      )
    }
    return []
  }
  if (!stored) {
    throw new ToolError(
      "not_found",
      `The mirror holds no tag list for channel ${channel}: list the forum's posts with discord_chat_read method threads first, which stores its tags, then post with tag ids from its result.`,
    )
  }
  const listed = new Map(stored.map((tag) => [tag.id, tag]))
  const unknown = tags.filter((id) => !listed.has(id))
  if (unknown.length > 0) {
    throw new ToolError(
      "invalid_argument",
      `Not a tag of channel ${channel}: ${unknown.join(", ")}. Its tags are: ${tagList(stored)}.`,
    )
  }
  return tags.map((id) => listed.get(id)!)
}
