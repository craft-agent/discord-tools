import { z } from "zod"
import { snowflakeId } from "../discord/id-schema"
import { threadCreateInput } from "./schemas"

export const threadMembershipInput = z.object({
  account: threadCreateInput.shape.account,
  thread: snowflakeId("a thread id").describe(
    "The thread to join or leave: the id of a public, private or announcement thread, or of a forum or media post, that the mirror knows (find it with discord_chat_read, method threads); never a name, and never the id of the channel the thread belongs to.",
  ),
})

/** The arguments of `discord_thread_join` and `discord_thread_leave` after validation. */
export type ThreadMembershipInput = z.output<typeof threadMembershipInput>

export const threadMembershipOutput = z.object({
  thread: z.string().describe("The id of the thread."),
  channel: z.string().nullable().describe("The channel the thread belongs to, or null when the mirror holds none."),
  server: z.string().nullable().describe("The server the channel is in."),
  name: z.string().describe("The thread's name as people see it, from the mirror."),
  joined: z
    .boolean()
    .describe("Whether the user is in the thread after the call: true after a join, false after a leave."),
  note: z.string(),
})

/** The result of `discord_thread_join` and `discord_thread_leave`. */
export type ThreadMembershipResult = z.infer<typeof threadMembershipOutput>
