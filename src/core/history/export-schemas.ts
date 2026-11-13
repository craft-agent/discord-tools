import { z } from "zod"
import { actionFields } from "../actions/schemas"
import { snowflakeId } from "../discord/id-schema"
import { EXPORT_FORMATS, type ExportFormat } from "./export-format"
import { EXPORT_LIMIT_DEFAULT, EXPORT_LIMIT_MAX } from "./export-select"
import { chatCount } from "./schemas"

/** The format an export is written in when `format` is left out. */
export const EXPORT_FORMAT_DEFAULT: ExportFormat = "markdown"

export const exportInput = z.object({
  account: actionFields.account,
  chat: snowflakeId("a chat id").describe(
    "The chat to export: the id of a DM, group DM, or text or announcement channel the mirror knows, from discord_chat_read; never a name. A sync run must have stored some of its history in one piece: it does for every DM, for a server channel only while it is on the sync list, and never for a thread or a voice channel. A live read does not make a chat exportable.",
  ),
  format: z
    .enum(EXPORT_FORMATS)
    .optional()
    .describe(
      "The file's format: `markdown` (default, for reading), `json` (one object) or `jsonl` (a head line, then one message per line).",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Only messages after this: a message id, a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone (a timestamp includes its own instant). With it the export takes the first `limit` messages from there; without it, the newest `limit`.",
    ),
  before: z
    .string()
    .optional()
    .describe(
      "Only messages before this: a message id, a date (YYYY-MM-DD, UTC midnight) or a timestamp with a zone. Default: up to the newest message the mirror holds in one piece.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `The most messages in the file (default ${EXPORT_LIMIT_DEFAULT}, at most ${EXPORT_LIMIT_MAX}). A text is never cut: the export stops at a whole message and the result says how to continue.`,
    ),
  time_zone: z
    .string()
    .optional()
    .describe(
      "The IANA time zone name the file's times and the days in its name are written in (such as `Asia/Tokyo`). Default: this machine's. The result names the zone it used.",
    ),
})

/** The arguments of `discord_export_create` after validation. */
export type ExportInput = z.output<typeof exportInput>

const moment = z.object({
  id: z.string().describe("The message's id."),
  at: z.string().describe("When it was sent, as an ISO 8601 UTC time."),
})

export const exportOutput = z.object({
  path: z.string().describe("The absolute path of the file that was written."),
  file: z.string().describe("The file's base name; a number is added when the name was taken."),
  format: z.enum(EXPORT_FORMATS),
  bytes: z.number().int().min(0).describe("How many bytes the file holds (UTF-8)."),
  time_zone: z.string().describe("The time zone the file's times and the days in its name are written in."),
  count: z.number().int().min(1).describe("How many messages the file holds."),
  first: moment.describe("The oldest message in the file."),
  last: moment.describe("The newest message in the file."),
  chat: chatCount.shape.chat,
  complete_to_start: z
    .boolean()
    .describe("Whether the file reaches the chat's first message: nothing older exists or is held."),
  truncated: z.boolean().describe("Whether `limit` cut the export, so more messages in the range are not in the file."),
  current: z.boolean().describe("Whether a sync run marked the chat current in the last 15 minutes."),
  left_out: z
    .number()
    .int()
    .min(0)
    .describe(
      "How many stored messages lie past the newest the mirror holds in one piece (within `before`) and so are not in the file.",
    ),
  continue: z
    .object({
      older: z
        .object({ before: z.string() })
        .nullable()
        .describe("Export again with this `before` for the older messages the mirror holds, or null."),
      backfill_first: z
        .boolean()
        .describe(
          "True when the mirror reaches no further back though the chat does: backfill it first (`discord_chat_read` method `backfill`, for a chat the sync follows), then export again with `before` the oldest message.",
        ),
      newer: z
        .object({ after: z.string() })
        .nullable()
        .describe("Export again with this `after` for the newer messages `limit` cut, or null."),
    })
    .describe("How to go on from this file."),
  note: z.string(),
})

/** The result of `discord_export_create`. */
export type ExportResult = z.infer<typeof exportOutput>
