import { z } from "zod"
import { snowflakeId } from "../discord/id-schema"
import { sendInput } from "../sends/schemas"
import { THREAD_NAME_MAX, threadCreateInput, threadName } from "./schemas"

/** The most tags a post carries; Discord refuses more. */
export const POST_TAGS_MAX = 5

export const postCreateInput = z.object({
  account: threadCreateInput.shape.account,
  channel: snowflakeId("a channel id").describe(
    "The forum or media channel to post in: the id of a channel of a server the mirror knows, from discord_chat_read; never a name.",
  ),
  name: threadName.describe(
    `The post's name, sent exactly as given (never trimmed or rewritten), at most ${THREAD_NAME_MAX} characters. Everyone who sees the forum sees it.`,
  ),
  text: sendInput.shape.text,
  tags: z
    .array(snowflakeId("a tag id"))
    .min(1)
    .max(POST_TAGS_MAX)
    .refine((tags) => new Set(tags).size === tags.length, "must not repeat a tag")
    .optional()
    .describe(
      `1 to ${POST_TAGS_MAX} tag ids of this forum, from discord_chat_read method threads (never names). Left out, the post has no tag; a forum that requires one refuses that.`,
    ),
  silent: sendInput.shape.silent,
  mass_mentions: sendInput.shape.mass_mentions,
})

/** The arguments of `discord_post_create` after validation. */
export type PostCreateInput = z.output<typeof postCreateInput>

export const postCreateOutput = z.object({
  id: z.string().describe("The id of the post, which is the id of its thread; reply in it with discord_message_send."),
  channel: z.string().describe("The forum or media channel the post is in."),
  server: z.string().nullable().describe("The server the channel is in."),
  name: z.string(),
  tags: z.array(z.string()).describe("The ids of the tags applied, as Discord says; else as given."),
  message: z.string().describe("The id of the post's first message, which is the post's own id."),
  sent_at: z.string().describe("When Discord made the post, from its id; ISO 8601 UTC."),
  silent: z.boolean(),
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe("Steps that failed after Discord created the post, keyed by step; the post was created all the same."),
})

/** The result of `discord_post_create`. */
export type PostCreateResult = z.infer<typeof postCreateOutput>
