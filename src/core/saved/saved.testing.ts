import { createActionsFixture } from "../actions/actions.testing"
import { msgId } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { SAVED_PATH } from "./entries"
import { discordSavedAdd, discordSavedRemove } from "./saved-tool"

/** One entry of Discord's list of saved messages, for the message `msgId(n)` in `channel`; `message` is what Discord sends of it (absent: none). */
export function saveEntry(
  channel: string,
  n: number,
  save: { savedAt?: string; dueAt?: string | null; guild?: string } = {},
  message: unknown = null,
) {
  return {
    message,
    save_data: {
      channel_id: channel,
      message_id: msgId(n),
      ...(save.guild === undefined ? {} : { guild_id: save.guild }),
      saved_at: save.savedAt ?? "2026-01-01T00:00:00.000000+00:00",
      due_at: save.dueAt ?? null,
    },
  }
}

/** Makes Discord answer the list of saved messages with these entries. */
export const savedList = (...results: unknown[]) => ({ status: 200, json: { results } })

/** A label as `createActionsFixture` makes it, with a way to run each saved-message tool and the path of the list. */
export async function createSavedFixture() {
  const f = await createActionsFixture()
  return {
    ...f,
    /** Runs `discord_saved_add` as an entry point does: strict arguments, a result checked against its schema. */
    save: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordSavedAdd, args, ctx),
    /** Runs `discord_saved_remove` the same way. */
    unsave: (args: unknown, ctx: ToolContext = f.ctx) => invoke(discordSavedRemove, args, ctx),
    /** The requests that read the list of saved messages, as a read-back does. */
    listReads: () => f.discord.api.filter((request) => request.method === "GET" && request.path === SAVED_PATH),
  }
}

export type SavedFixture = Awaited<ReturnType<typeof createSavedFixture>>
