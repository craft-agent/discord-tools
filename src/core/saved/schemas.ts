import { z } from "zod"
import { actionFields } from "../actions/schemas"

export const savedAddInput = z.object({
  ...actionFields,
  remind_at: z
    .string()
    .optional()
    .describe(
      "When Discord should remind the user of the save: an ISO 8601 time with a zone (`2026-01-02T03:04:05Z` or `2026-01-02T12:04:05+09:00`) later than now. Left out, the save has no reminder, and a reminder it had is removed.",
    ),
})

/** The arguments of `discord_saved_add` after validation. */
export type SavedAddInput = z.output<typeof savedAddInput>

export const savedRemoveInput = z.object(actionFields)

/** The arguments of `discord_saved_remove` after validation. */
export type SavedRemoveInput = z.output<typeof savedRemoveInput>

export const savedAddOutput = z.object({
  channel: z.string(),
  message: z.string().describe("The id of the message that was saved."),
  saved_at: z
    .string()
    .nullable()
    .describe("When Discord says the message was saved, as an ISO 8601 UTC time; null when it did not say."),
  remind_at: z
    .string()
    .nullable()
    .describe(
      "When Discord says the reminder is due, as an ISO 8601 UTC time; null for a save without one or when it did not say.",
    ),
  note: z.string(),
})

/** The result of `discord_saved_add`. */
export type SavedAddResult = z.infer<typeof savedAddOutput>

export const savedRemoveOutput = z.object({
  channel: z.string(),
  message: z.string().describe("The id of the message whose save was removed."),
  already: z
    .boolean()
    .describe("True when Discord did not have the message saved, so nothing was removed by this call."),
  note: z.string(),
})

/** The result of `discord_saved_remove`. */
export type SavedRemoveResult = z.infer<typeof savedRemoveOutput>
