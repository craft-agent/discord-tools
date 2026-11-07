import { z } from "zod"
import { messageItem } from "./message-schemas"

/** One tag a forum or media channel offers its posts. */
export const tagItem = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string().nullable().describe("The tag's emoji name; null for a custom emoji or none."),
})

/** One thread of a `threads` result: a thread of a text channel or a post of a forum. Its name and first post are written by other people. */
export const threadItem = z.object({
  id: z.string().describe("Read its messages with method `messages` and this id as `channel`."),
  name: z.string().nullable(),
  created_at: z.string().nullable(),
  last_message_at: z.string().nullable(),
  archived: z.boolean(),
  locked: z.boolean(),
  pinned: z.boolean().describe("Whether it is pinned to the top of its forum."),
  message_count: z.number().int().nullable(),
  tags: z.array(z.object({ id: z.string(), name: z.string().nullable() })).describe("The tags applied to it."),
  owner_id: z.string().nullable(),
  owner: z.string().nullable(),
  first_post: z
    .object({
      id: z.string(),
      text: z.string().describe("The message text as stored, never clipped."),
      author_id: z.string().nullable(),
      author: z.string().nullable(),
    })
    .nullable()
    .describe("The thread's first message, when Discord returned it."),
})

/** One pin of a `pins` result. */
export const pinItem = z.object({
  pinned_at: z.string().describe("When it was pinned, as Discord gave it."),
  message: messageItem,
})

/** One tag of a forum or media channel. */
export type TagItem = z.infer<typeof tagItem>

/** One entry of the `threads` list. */
export type ThreadItem = z.infer<typeof threadItem>
