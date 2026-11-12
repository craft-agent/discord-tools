import { z } from "zod"
import type { ChatSession } from "../chats/session"

/** The methods of `discord_people_read`; a method is added here, in `args.ts` and in the dispatch table of `read.ts`. */
export const PEOPLE_METHODS = ["friends", "notes", "profile", "member", "members"] as const

/** One method of `discord_people_read`. */
export type PeopleMethod = (typeof PEOPLE_METHODS)[number]

/** The longest `query` a filter takes, in characters. */
export const QUERY_MAX_LENGTH = 100

/** How many members `members` lists when `limit` is left out, and the most it lists. */
export const MEMBERS_LIMIT_DEFAULT = 25
export const MEMBERS_LIMIT_MAX = 100

export const peopleReadInput = z.object({
  account: z.string().optional().describe("The account label; left out, the only signed-in account."),
  method: z
    .enum(PEOPLE_METHODS)
    .describe(
      "What to read: `friends` is the user's own friend list, with the nickname the user gave each friend and the DM with them the local mirror already holds, and the number of pending requests; `notes` are the user's own private notes about other users, all of them or the one on `user`; `profile` is one person's profile (bio, pronouns, connected accounts, mutual servers and friends); `member` is one person's membership of one server, with the names of their roles; `members` searches a server's members by name. All are read from Discord on every call.",
    ),
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_LENGTH)
    .optional()
    .describe(
      "Method `friends`: only friends whose name, username or nickname contains this text, ignoring case. Filters the list locally; never an id or a way to find other people. Method `members` (required): the name Discord searches the server's members for.",
    ),
  user: z
    .string()
    .optional()
    .describe(
      "Method `notes`: only the note on this user. Methods `profile` and `member` (required): the person to read. Their id, which the local mirror must know (from a friend list, a DM, a chat's messages or a mention); never a name. For `notes`, left out, every note.",
    ),
  server: z
    .string()
    .optional()
    .describe(
      "Method `profile`: also the person's profile as a member of this server. Methods `member` and `members` (required): the server. Its id, which the local mirror must know (from `discord_chat_read` method `servers`); never a name.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MEMBERS_LIMIT_MAX)
    .optional()
    .describe(
      `Method \`members\`: how many members to list at most, 1 to ${MEMBERS_LIMIT_MAX}. Default ${MEMBERS_LIMIT_DEFAULT}.`,
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

const memberOfProfile = z.object({
  server: z.string().describe("The server's id."),
  nick: z.string().nullable().describe("The nickname in that server; null when none."),
  joined: z
    .string()
    .nullable()
    .describe("When the person joined the server, as an ISO 8601 UTC time; null if unknown."),
  roles: z.array(z.string()).describe("The ids of their roles there; method `member` names them."),
})

const profileItem = z.object({
  id: z.string().describe("The person's user id."),
  name: z.string().describe("The display name, else the username; the id when neither is known."),
  username: z.string().nullable(),
  bot: z.boolean(),
  bio: z.string().nullable().describe("The person's own bio; null when empty."),
  pronouns: z.string().nullable().describe("The person's own pronouns; null when empty."),
  connected_accounts: z
    .array(
      z.object({
        type: z.string().describe("The service, such as `github`."),
        name: z.string().describe("The account's name there, written by the person."),
        verified: z.boolean(),
      }),
    )
    .describe("The accounts the person connected and shows."),
  mutual_servers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable().describe("The server's name from the local mirror; null when it does not hold it."),
        nick: z.string().nullable().describe("The person's nickname in that server; null when none."),
      }),
    )
    .describe("The servers the user and the person share."),
  mutual_friends: z
    .array(z.object({ id: z.string(), name: z.string(), username: z.string().nullable() }))
    .describe("The friends the user and the person share, ordered by name (ignoring case), then id."),
  mutual_friends_count: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe("How many mutual friends Discord counts; null if not said."),
  member: memberOfProfile
    .nullable()
    .describe("With `server`: the person's membership there; null without `server` or when Discord sent none."),
})

const memberItem = z.object({
  server: z.string().describe("The server's id."),
  server_name: z
    .string()
    .nullable()
    .describe("The server's name from the local mirror; null when it does not hold it."),
  user: z.string().describe("The person's user id."),
  name: z
    .string()
    .describe("The nickname in this server, else the display name, else the username; the id if none is known."),
  username: z.string().nullable(),
  nick: z.string().nullable().describe("The nickname in this server; null when none."),
  joined: z.string().nullable().describe("When the person joined, as an ISO 8601 UTC time; null if unknown."),
  roles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable().describe("The role's name; null for a role the server no longer lists."),
      }),
    )
    .describe("The person's roles, highest first (by position, then id); the @everyone role is not listed."),
})

const memberHit = z.object({
  id: z.string().describe("The person's user id."),
  name: z
    .string()
    .describe("The nickname in this server, else the display name, else the username; the id if none is known."),
  username: z.string().nullable(),
  nick: z.string().nullable().describe("The nickname in this server; null when none."),
  joined: z.string().nullable().describe("When the person joined, as an ISO 8601 UTC time; null if unknown."),
  roles: z.array(z.string()).describe("The ids of their roles; method `member` names them."),
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
      "Methods `friends`, `notes` and `members`: how many friends are listed (after `query`), how many notes exist among those listed, or how many members are listed.",
    ),
  total: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe(
      "Method `friends`: how many friends the user has, before `query`. Method `members`: how many members match, as Discord counts them; null when it does not say.",
    ),
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
  profile: profileItem.optional().describe("Method `profile`: the person's profile, read from Discord once."),
  member: memberItem.optional().describe("Method `member`: the person's membership of the server."),
  members: z
    .array(memberHit)
    .optional()
    .describe("Method `members`: the members Discord's search found, in Discord's order."),
})

/** The result of `discord_people_read`. */
export type PeopleReadResult = z.infer<typeof peopleReadOutput>

/** One friend of a `friends` result. */
export type FriendItem = z.infer<typeof friendItem>

/** One note of a `notes` result. */
export type NoteItem = z.infer<typeof noteItem>

/** The profile of a `profile` result. */
export type ProfileItem = z.infer<typeof profileItem>

/** The membership of a `member` result. */
export type MemberItem = z.infer<typeof memberItem>

/** One member of a `members` result. */
export type MemberHit = z.infer<typeof memberHit>

/** What a method returns; the tool adds `method`. */
export type PeoplePayload = Omit<PeopleReadResult, "method">

/** One method of `discord_people_read`, over an open session. */
export type PeopleHandler = (session: ChatSession, args: PeopleReadInput) => Promise<PeoplePayload>
