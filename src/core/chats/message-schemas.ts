import { z } from "zod"

const reference = z.object({ message: z.string().nullable(), channel: z.string().nullable() })

const attachmentItem = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  type: z.string().nullable().describe("The MIME type."),
  size: z.number().int().nullable().describe("The size in bytes."),
  url: z.string().nullable(),
})

/** One message of a `messages` or `around` result. Its text, embeds and file names are written by other people. */
export const messageItem = z.object({
  id: z.string(),
  at: z.string().describe("When it was sent, as an ISO 8601 UTC time."),
  edited_at: z.string().nullable(),
  type: z.number().int().describe("Discord's message type number; 0 is an ordinary message, 19 a reply."),
  event: z
    .string()
    .nullable()
    .describe("What a system message records (`pinned a message`, `joined`, `system`, …); null for a written message."),
  from_me: z.boolean(),
  author_id: z.string().nullable(),
  author: z.string().nullable().describe("The server nickname, else the display name, else the username."),
  text: z.string().describe("The message text as stored, never clipped."),
  reply_to: reference.nullable().describe("The message this one replies to."),
  forwarded_from: reference.nullable().describe("Where this forwarded message came from."),
  attachments: z.array(attachmentItem),
  embeds: z.array(z.record(z.string(), z.unknown())).describe("The readable parts of each embed, clipped."),
  stickers: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number().int(), me: z.boolean() })),
  pinned: z.boolean(),
  mentions_me: z.boolean().describe("Whether it mentions the user or everyone."),
})

/** One message of a `messages` or `around` result. */
export type MessageItem = z.infer<typeof messageItem>
