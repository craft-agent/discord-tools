import { CATEGORY, FORUM, seedChannels, seedHistory } from "../chats/read.messages.testing"
import { createChatFixture } from "../chats/read.testing"
import { ingestChannels, ingestMessages } from "../discord/ingest"
import { isChannelCurrent } from "../discord/mirror-cursors"
import {
  ALICE,
  CHANNEL,
  channelObject,
  DM,
  ME,
  messageObject,
  msgId,
  OTHER_CHANNEL,
  SERVER,
  userObject,
} from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordThreadCreate } from "./create-tool"

/** An announcement channel, a thread of `CHANNEL` and a media channel, which the mirror holds, besides the forum, the category and the DM. */
export const ANNOUNCEMENT = "1400000000000000212"
export const OLD_THREAD = "1400000000000000213"
export const MEDIA = "1400000000000000214"
export { CATEGORY, DM, FORUM }

/** The id Discord gives a thread started without a message. */
export const NEW_THREAD = "1400000000000000220"

/** A message of Alice in `CHANNEL` the mirror holds, one in an announcement channel, and one in another channel the mirror does not know. */
export const SAID = msgId(2)
export const NEWS_MESSAGE = msgId(30)
export const ELSEWHERE = msgId(20)

/** The made-up thread name every test starts. */
export const NAME = "Release planning"

/** The path of the request that starts a standalone thread in a channel, and the one that starts a thread from a message. */
export const startPath = (channel = CHANNEL) => `/channels/${channel}/threads`
export const fromMessagePath = (message = SAID, channel = CHANNEL) => `/channels/${channel}/messages/${message}/threads`

/** The path of the thread search a read-back of a standalone thread reads. */
export const searchPath = (channel = CHANNEL) => `/channels/${channel}/threads/search`

/** The thread Discord answers a creation with: a public thread of `CHANNEL` owned by the account; `extra` overrides any field. */
export function threadObject(id: string, extra: Record<string, unknown> = {}) {
  return channelObject(id, {
    type: 11,
    guild_id: SERVER,
    parent_id: CHANNEL,
    name: NAME,
    owner_id: ME,
    thread_metadata: {
      archived: false,
      locked: false,
      auto_archive_duration: 1440,
      create_timestamp: "2026-01-01T00:00:00+00:00",
    },
    ...extra,
  })
}

/** A label whose mirror holds `CHANNEL` (current, with messages), a forum, a category, an announcement channel, a thread, a DM and messages in two channels. */
export async function createThreadsFixture() {
  const f = await createChatFixture()
  seedChannels(f)
  seedHistory(f, [1, 2, 3], { current: true })
  f.seed((m) => {
    ingestChannels(
      m,
      f.ingestContext(),
      [
        channelObject(ANNOUNCEMENT, { type: 5, name: "news" }),
        channelObject(MEDIA, { type: 16, name: "gallery" }),
        threadObject(OLD_THREAD, { name: "old" }),
        channelObject(DM, { type: 1, name: null, recipients: [userObject(ALICE)] }),
      ],
      SERVER,
    )
    ingestMessages(
      m,
      f.ingestContext(),
      [messageObject(NEWS_MESSAGE, ANNOUNCEMENT), messageObject(ELSEWHERE, OTHER_CHANNEL)],
      { reactions: true },
    )
  })
  return {
    ...f,
    /** Runs `discord_thread_create` as an entry point does: strict arguments, a result checked against its schema. */
    create: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordThreadCreate, args, ctx),
    /** The requests that changed something: everything but reads. */
    writes: () => f.discord.api.filter((request) => request.method !== "GET"),
    /** The requests that read: the read-back after an uncertain creation. */
    reads: () => f.discord.api.filter((request) => request.method === "GET"),
    /** A stored channel as the mirror holds it; `undefined` when it is not there. */
    row: (id: string) =>
      f.inspect(
        (m) =>
          m
            .prepare("SELECT type, name, CAST(parent AS TEXT) AS parent, thread FROM channels WHERE id = ?")
            .get(BigInt(id)) as
            { type: number; name: string | null; parent: string | null; thread: string | null } | undefined,
      ),
    /** Whether a sync run marked the channel current within the freshness window. */
    isCurrent: (id: string) => f.inspect((m) => isChannelCurrent(m, id, f.now())),
  }
}

export type ThreadsFixture = Awaited<ReturnType<typeof createThreadsFixture>>
