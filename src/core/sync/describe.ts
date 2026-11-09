import { channelName, serverName, withMirror } from "../chats/describe"
import type { Mirror } from "../discord/mirror"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import type { SyncAddInput, SyncRemoveInput } from "./write-schemas"

/** Channels as `#name` in the order given, each by its id when the mirror holds no name, joined for one fact. */
function channelNames(mirror: Mirror, ids: string[]): string {
  return ids.map((id) => channelName(mirror, id)).join(", ")
}

/**
 * What adding to the sync list will do, from the mirror alone: the server, whether
 * the whole server or named channels are followed, and those channels or the
 * ones a whole server leaves out.
 */
export function describeSyncAdd(args: SyncAddInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const server = serverName(mirror, args.server)
    const facts: CallFact[] = [
      { label: "Follows", value: { text: args.channels ? "Named channels" : "Whole server" } },
      ...(args.channels ? [{ label: "Channels", value: channelNames(mirror, args.channels) }] : []),
      ...(args.exclude ? [{ label: "Excluded", value: channelNames(mirror, args.exclude) }] : []),
    ]
    return {
      headline: {
        text: args.channels ? "About to follow channels of {server}" : "About to follow {server}",
        values: { server },
      },
      facts,
    }
  })
}

/**
 * What removing from the sync list will do, from the mirror alone: the server
 * and, when only some channels go, which ones. A server the mirror lacks is
 * named by its id, since an account that left it can still drop it.
 */
export function describeSyncRemove(args: SyncRemoveInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const server = serverName(mirror, args.server)
    return {
      headline: {
        text: args.channels ? "About to stop following channels of {server}" : "About to stop following {server}",
        values: { server },
      },
      facts: args.channels ? [{ label: "Channels", value: channelNames(mirror, args.channels) }] : [],
    }
  })
}
