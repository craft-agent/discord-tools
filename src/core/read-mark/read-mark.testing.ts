import { createActionsFixture, SYSTEM } from "../actions/actions.testing"
import { ingestChannels } from "../discord/ingest"
import { CHANNEL, channelObject, SERVER } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordReadMark } from "./read-mark-tool"

/** A server channel the mirror knows and holds no message of. */
export const EMPTY_CHANNEL = "1400000000000000202"

/** The newest message of `CHANNEL` in the actions fixture, which a mark without a message reaches. */
export const NEWEST = SYSTEM

/** The path of the request that marks `message` of `channel` read. */
export const ackPath = (message: string, channel = CHANNEL) => `/channels/${channel}/messages/${message}/ack`

/** A label as `createActionsFixture` makes it, plus a channel with no messages and a way to run `discord_read_mark`. */
export async function createReadMarkFixture() {
  const f = await createActionsFixture()
  f.seed((m) => ingestChannels(m, f.ingestContext(), [channelObject(EMPTY_CHANNEL, { name: "quiet" })], SERVER))
  return {
    ...f,
    /** Runs `discord_read_mark` as an entry point does: strict arguments, a result checked against its schema. */
    mark: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordReadMark, args, ctx),
    /** The number of messages the mirror holds, to show a call stored nothing. */
    messageCount: () => f.inspect((m) => (m.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n),
  }
}

export type ReadMarkFixture = Awaited<ReturnType<typeof createReadMarkFixture>>
