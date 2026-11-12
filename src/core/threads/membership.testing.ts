import { ingestChannels } from "../discord/ingest"
import { ME, SERVER } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordThreadJoin, discordThreadLeave } from "./membership-tool"
import { ANNOUNCEMENT, createThreadsFixture, FORUM, threadObject } from "./threads.testing"

/** A private thread of the text channel, an announcement thread, and a forum post, which the mirror holds besides `OLD_THREAD`. */
export const PRIVATE_THREAD = "1400000000000000260"
export const NEWS_THREAD = "1400000000000000261"
export const FORUM_POST = "1400000000000000262"

/** The path of the request that joins (`PUT`) or leaves (`DELETE`) a thread, and the one that reads a member's record. */
export const membershipPath = (thread: string) => `/channels/${thread}/thread-members/@me`
export const memberPath = (thread: string) => `/channels/${thread}/thread-members/${ME}`

/** The threads fixture, with a private thread, an announcement thread and a forum post, and runners for the join and leave tools. */
export async function createMembershipFixture() {
  const f = await createThreadsFixture()
  f.seed((m) =>
    ingestChannels(
      m,
      f.ingestContext(),
      [
        threadObject(PRIVATE_THREAD, { type: 12, name: "secret" }),
        threadObject(NEWS_THREAD, { type: 10, parent_id: ANNOUNCEMENT, name: "news thread" }),
        threadObject(FORUM_POST, { parent_id: FORUM, name: "a post" }),
      ],
      SERVER,
    ),
  )
  return {
    ...f,
    /** Runs `discord_thread_join` as an entry point does: strict arguments, a result checked against its schema. */
    join: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordThreadJoin, args, ctx),
    /** Runs `discord_thread_leave` the same way. */
    leave: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordThreadLeave, args, ctx),
    /** Every stored channel row, to see that a call left the mirror as it was. */
    channels: () =>
      f.inspect((m) =>
        m
          .prepare(
            "SELECT CAST(id AS TEXT) AS id, type, name, CAST(parent AS TEXT) AS parent, thread FROM channels ORDER BY id",
          )
          .all(),
      ),
  }
}

export type MembershipFixture = Awaited<ReturnType<typeof createMembershipFixture>>
