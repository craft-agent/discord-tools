import { ingestChannels } from "../discord/ingest"
import { channelObject, ME, messageObject, SERVER, userObject } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordPostCreate } from "./post-tool"
import { createThreadsFixture, NAME, threadObject } from "./threads.testing"

/** A forum with two tags, one that requires a tag, and one that requires a tag but whose tags the mirror does not hold. */
export const TAGGED_FORUM = "1400000000000000230"
export const STRICT_FORUM = "1400000000000000231"
export const STRICT_BARE_FORUM = "1400000000000000232"

/** The tags of the forums above, and a tag of no forum. */
export const BUG = "1400000000000000240"
export const IDEA = "1400000000000000241"
export const STRANGER = "1400000000000000242"

/** The id Discord gives a new post, which is its first message's id too. */
export const NEW_POST = "1400000000000000250"

/** The made-up text every test posts. */
export const TEXT = "The plan, in short."

/** The path of the request that makes a post, and the one that searches a forum's posts. */
export const postPath = (forum = TAGGED_FORUM) => `/channels/${forum}/threads`
export const postSearchPath = (forum = TAGGED_FORUM) => `/channels/${forum}/threads/search`

const AVAILABLE_TAGS = [
  { id: BUG, name: "Bug", emoji_name: null },
  { id: IDEA, name: "Idea", emoji_name: "💡" },
]

/** The post Discord answers with: a public thread of `forum` owned by the account that carries `BUG`; `extra` overrides any field. */
export const postObject = (
  id = NEW_POST,
  forum = TAGGED_FORUM,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => threadObject(id, { parent_id: forum, applied_tags: [BUG], ...extra })

/** The first message of a post, which has the post's id and lies in the post; `extra` overrides any field. */
export const starterObject = (id = NEW_POST, extra: Record<string, unknown> = {}) =>
  messageObject(id, id, { author: userObject(ME), content: TEXT, ...extra })

/** The threads fixture, with a forum that has tags, forums that require one, and a runner for `discord_post_create`. */
export async function createPostsFixture() {
  const f = await createThreadsFixture()
  f.seed((m) =>
    ingestChannels(
      m,
      f.ingestContext(),
      [
        channelObject(TAGGED_FORUM, { type: 15, name: "ideas", available_tags: AVAILABLE_TAGS }),
        channelObject(STRICT_FORUM, { type: 15, name: "rules", flags: 16, available_tags: AVAILABLE_TAGS }),
        channelObject(STRICT_BARE_FORUM, { type: 16, name: "strict", flags: 16 }),
      ],
      SERVER,
    ),
  )
  return {
    ...f,
    /** Runs `discord_post_create` as an entry point does: strict arguments, a result checked against its schema. */
    post: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordPostCreate, args, ctx),
    /** A stored message as the mirror holds it; `undefined` when it is not there. */
    message: (id: string) =>
      f.inspect(
        (m) =>
          m
            .prepare("SELECT CAST(channel AS TEXT) AS channel, content, from_me FROM messages WHERE id = ?")
            .get(BigInt(id)) as { channel: string; content: string; from_me: number } | undefined,
      ),
  }
}

export type PostsFixture = Awaited<ReturnType<typeof createPostsFixture>>

/** A valid call that every test starts from. */
export const POST = { channel: TAGGED_FORUM, name: NAME, text: TEXT }
