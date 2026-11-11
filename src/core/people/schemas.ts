import { z } from "zod"
import type { ChatSession } from "../chats/session"

/** The methods of `discord_people_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const PEOPLE_METHODS = ["friends", "notes"] as const

/** One method of `discord_people_read`. */
export type PeopleMethod = (typeof PEOPLE_METHODS)[number]

/** The longest `query` a filter takes, in characters. */
export const QUERY_MAX_LENGTH = 100

export const peopleReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(PEOPLE_METHODS)
    .describe(
      "What to read: `friends` is the user's own friend list, with the nickname the user gave each friend and the DM with them the local mirror already holds, and the number of pending requests; `notes` are the user's own private notes about other users, all of them or the one on `user`. Both are read from Discord on every call.",
    ),
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_LENGTH)
    .optional()
    .describe(
      "Method `friends`: only friends whose name, username or nickname contains this text, ignoring case. Filters the list locally; never an id or a way to find other people.",
    ),
  user: z
    .string()
    .optional()
    .describe(
      "Method `notes`: only the note on this user: their id, which the local mirror must know (from a friend list, a DM, a chat's messages or a mention); never a name. Left out, every note.",
    ),
})

/** The arguments of `discord_people_read` after validation. */
export type PeopleReadInput = z.output<typeof peopleReadInput>

const friendItem = z.object({
  id: z.string().describe("The friend's user id."),
  name: z.string().describe("The display name, else the username; the id when Discord sent neither."),
  username: z.string().nullable(),
  nickname: z.string().nullable().describe("The nickname the user gave this friend; null when none."),
  since: z.string().nullable().describe("When the friendship began, as an ISO 8601 UTC time; null when not known."),
  dm: z
    .string()
    .nullable()
    .describe(
      "The id of the DM with this friend that the local mirror already holds; null when it holds none. No DM is opened for the call.",
    ),
})

const noteItem = z.object({
  user: z.string().describe("The id of the user the note is about."),
  name: z
    .string()
    .nullable()
    .describe("The user's display name, else username, from the local mirror; null when it does not know the user."),
  username: z.string().nullable(),
  note: z.string().nullable().describe("The note's text; null when the user has none on this user."),
})

export const peopleReadOutput = z.object({
  method: z.enum(PEOPLE_METHODS),
  note: z.string(),
  friends: z
    .array(friendItem)
    .optional()
    .describe("Method `friends`: friends only, ordered by name (ignoring case), then id."),
  count: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Methods `friends` and `notes`: how many friends are listed (after `query`), or how many notes exist among those listed.",
    ),
  total: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Method `friends`: how many friends the user has, before `query`."),
  requests: z
    .object({
      incoming: z.number().int().min(0).describe("Friend requests received and not yet answered."),
      outgoing: z.number().int().min(0).describe("Friend requests sent and not yet answered."),
    })
    .optional()
    .describe("Method `friends`: pending friend requests, counted without saying who they are from or to."),
  notes: z
    .array(noteItem)
    .optional()
    .describe(
      "Method `notes`: every note ordered by the user's name (unknown names last), then id; with `user`, that one user, whose `note` is null when there is none.",
    ),
})

/** The result of `discord_people_read`. */
export type PeopleReadResult = z.infer<typeof peopleReadOutput>

/** One friend of a `friends` result. */
export type FriendItem = z.infer<typeof friendItem>

/** One note of a `notes` result. */
export type NoteItem = z.infer<typeof noteItem>

/** What a method returns; the tool adds `method`. */
export type PeoplePayload = Omit<PeopleReadResult, "method">

/** One method of `discord_people_read`, over an open session. */
export type PeopleHandler = (session: ChatSession, args: PeopleReadInput) => Promise<PeoplePayload>
