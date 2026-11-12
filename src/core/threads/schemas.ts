import { z } from "zod"
import { snowflakeId } from "../discord/id-schema"

/** The longest thread `name`, in UTF-16 units; Discord refuses a longer name itself, so this only bounds what is sent to it. */
export const THREAD_NAME_MAX = 100

/** The minutes of inactivity after which a thread archives that Discord accepts. */
export const AUTO_ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const

/** A thread name: 1 to `THREAD_NAME_MAX` characters, not whitespace only, and otherwise as given. */
const threadName = z
  .string()
  .min(1)
  .max(THREAD_NAME_MAX)
  .refine((name) => name.trim() !== "", "must contain a character other than whitespace")

export const threadCreateInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  channel: snowflakeId("a channel id").describe(
    "The text or announcement channel to start the thread in: the id of a channel of a server the mirror knows, from discord_chat_read; never a name.",
  ),
  message: snowflakeId("a message id")
    .optional()
    .describe(
      "The id of a message in this channel, already in the mirror (read the channel first), to start the thread from; the thread is public and its id is this message's id. Left out, a standalone thread is started.",
    ),
  name: threadName.describe(
    `The thread's name, sent exactly as given (never trimmed or rewritten), at most ${THREAD_NAME_MAX} characters. Everyone who sees the channel sees it.`,
  ),
  private: z
    .boolean()
    .optional()
    .describe(
      "Start a private thread (default false: public). Only without `message`, and only in a text channel, not an announcement channel.",
    ),
  auto_archive: z
    .literal([...AUTO_ARCHIVE_MINUTES])
    .optional()
    .describe(
      "Minutes without activity before the thread archives: 60, 1440, 4320 or 10080. Left out, Discord's default applies.",
    ),
})

/** The arguments of `discord_thread_create` after validation. */
export type ThreadCreateInput = z.output<typeof threadCreateInput>

/** What a thread is called in a result, by Discord's channel type: 10 announcement, 11 public, 12 private. */
export const THREAD_KIND_BY_TYPE: Readonly<Record<number, "public" | "private" | "announcement">> = {
  10: "announcement",
  11: "public",
  12: "private",
}

export const threadCreateOutput = z.object({
  id: z.string().describe("The id of the thread; send its first message to this id."),
  channel: z.string().describe("The channel the thread belongs to."),
  server: z.string().nullable().describe("The server the channel is in."),
  name: z.string(),
  type: z
    .enum(["public", "private", "announcement"])
    .describe("What Discord made: a public or private thread, or an announcement thread (in an announcement channel)."),
  from_message: z.string().nullable().describe("The message the thread was started from, or null."),
  archives_after: z
    .number()
    .nullable()
    .describe("Minutes without activity before the thread archives, as Discord says; null when it gave none."),
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Steps that failed after Discord created the thread, keyed by step; the thread was created all the same.",
    ),
})

/** The result of `discord_thread_create`. */
export type ThreadCreateResult = z.infer<typeof threadCreateOutput>
