import { CATEGORY, FORUM, seedChannels, seedHistory } from "../chats/read.messages.testing"
import { createChatFixture } from "../chats/read.testing"
import { ingestMessages, type StoredReaction } from "../discord/ingest"
import { CHANNEL, ME, messageObject, msgId, OTHER_CHANNEL, userObject } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordMessageDelete } from "./delete-tool"
import { discordMessageEdit } from "./edit-tool"
import { discordReactionAdd, discordReactionRemove } from "./reaction-tool"

/** The channel's messages path, which a read-back reads. */
export const MESSAGES_PATH = `/channels/${CHANNEL}/messages`

/** The account's own message in `CHANNEL`, with the text and the reactions the mirror holds. */
export const OWN = msgId(10)
export const OWN_TEXT = "original text"

/** A message of Alice in `CHANNEL`, which the mirror holds. */
export const THEIRS = msgId(2)

/** The account's own message in `OTHER_CHANNEL`, which is not a channel the mirror knows. */
export const ELSEWHERE = msgId(20)

/** When Discord says the edit happened, as it writes it and as the tool reports it. */
export const EDITED_TIMESTAMP = "2026-01-02T03:04:05.000000+00:00"
export const EDITED_AT = "2026-01-02T03:04:05.000Z"

/** The path of the request that edits or deletes a message of `CHANNEL`. */
export const messagePath = (id = OWN) => `${MESSAGES_PATH}/${id}`

/** The path of the request that adds (`rest` is `/@me`) or takes back (`/0/@me`) the account's own reaction `key`, which it percent-encodes. */
export const reactionPath = (key: string, rest: string, id = OWN) =>
  `${messagePath(id)}/reactions/${encodeURIComponent(key)}${rest}`

/** Arguments naming a message the tool must refuse before any request, with the code it refuses with. */
export const REFUSED_TARGETS: [string, Record<string, string>, string][] = [
  ["an unknown channel", { channel: "1400000000000000999", message: OWN }, "not_found"],
  ["an unknown message", { channel: CHANNEL, message: msgId(99) }, "not_found"],
  ["a message of another channel", { channel: CHANNEL, message: ELSEWHERE }, "not_found"],
  ["someone else's message", { channel: CHANNEL, message: THEIRS }, "forbidden"],
  ["a category", { channel: CATEGORY, message: OWN }, "invalid_argument"],
  ["a forum", { channel: FORUM, message: OWN }, "invalid_argument"],
  ["a message that is not an id", { channel: CHANNEL, message: "latest" }, "invalid_argument"],
]

/** A label whose mirror holds a channel, three messages of Alice, the account's own message with reactions, and one in another channel. */
export async function createActionsFixture() {
  const f = await createChatFixture()
  seedChannels(f)
  seedHistory(f, [1, 2, 3], { current: true })
  const own = (id: string, channel: string, extra: Record<string, unknown>) =>
    messageObject(id, channel, { author: userObject(ME), ...extra })
  f.seed((m) =>
    ingestMessages(
      m,
      f.ingestContext(),
      [
        own(OWN, CHANNEL, { content: OWN_TEXT, reactions: [{ emoji: { id: null, name: "👍" }, count: 2, me: false }] }),
        own(ELSEWHERE, OTHER_CHANNEL, {}),
      ],
      { reactions: true },
    ),
  )
  return {
    ...f,
    /** Runs `discord_message_edit` as an entry point does: strict arguments, a result checked against its schema. */
    edit: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordMessageEdit, args, ctx),
    /** Runs `discord_message_delete` the same way. */
    remove: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordMessageDelete, args, ctx),
    /** Runs `discord_reaction_add` the same way. */
    react: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordReactionAdd, args, ctx),
    /** Runs `discord_reaction_remove` the same way. */
    unreact: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordReactionRemove, args, ctx),
    /** Replaces the reactions the mirror holds on a message (`null`: none known). */
    setReactions: (id: string, reactions: StoredReaction[] | null) =>
      f.seed((m) =>
        m
          .prepare("UPDATE messages SET reactions = ? WHERE id = ?")
          .run(reactions === null ? null : JSON.stringify(reactions), BigInt(id)),
      ),
    /** The requests that changed something: everything but reads. */
    writes: () => f.discord.api.filter((request) => request.method !== "GET"),
    /** The requests that read the channel's messages. */
    readBacks: () => f.discord.api.filter((request) => request.method === "GET" && request.path === MESSAGES_PATH),
    /** A stored message as the mirror holds it; `undefined` when it is gone. */
    row: (id = OWN) =>
      f.inspect(
        (m) =>
          m.prepare("SELECT content, edited_at, reactions, from_me FROM messages WHERE id = ?").get(BigInt(id)) as
            { content: string; edited_at: number | null; reactions: string | null; from_me: number } | undefined,
      ),
    /** Makes the read-back answer with these messages. */
    serveAround: (messages: unknown[]) => f.discord.route("GET", MESSAGES_PATH, { status: 200, json: messages }),
  }
}

export type ActionsFixture = Awaited<ReturnType<typeof createActionsFixture>>

/** The message Discord answers an edit with: the account's own `OWN`, with `content`. */
export function editedMessage(content: string, extra: Record<string, unknown> = {}) {
  return messageObject(OWN, CHANNEL, {
    author: userObject(ME),
    content,
    edited_timestamp: EDITED_TIMESTAMP,
    ...extra,
  })
}
