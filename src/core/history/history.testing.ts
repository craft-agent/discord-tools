import { ME, messageObject, userObject } from "../discord/objects.testing"
import { snowflakeAt } from "../discord/snowflake"
import { createSearchFixture } from "../search/search.testing"
import { invoke } from "../tool"
import { discordHistoryRead } from "./read"

/** One day, in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000

/** A signed-in label with a mirror and a fake Discord behind the one HTTP client, and a way to run `discord_history_read`. */
export async function createHistoryFixture() {
  const f = await createSearchFixture()
  return {
    ...f,
    /** Runs `discord_history_read` as an entry point does: strict arguments, a result checked against its schema. */
    history: (args: unknown) => invoke(discordHistoryRead, args, f.ctx),
    /** Runs method `counts`. */
    counts: (args: Record<string, unknown> = {}) => invoke(discordHistoryRead, { method: "counts", ...args }, f.ctx),
  }
}

export type HistoryFixture = Awaited<ReturnType<typeof createHistoryFixture>>

/** The message in `channel` made at `time` (ms since the Unix epoch), `n` ids after the first of that millisecond; written by Alice unless `extra` says otherwise. */
export const sentAt = (channel: string, time: number | string, n = 0, extra: Record<string, unknown> = {}) =>
  messageObject(
    String(BigInt(snowflakeAt(typeof time === "string" ? Date.parse(time) : time)) + BigInt(n)),
    channel,
    extra,
  )

/** Like `sentAt`, written by the user. */
export const sentByMe = (channel: string, time: number | string, n = 0, extra: Record<string, unknown> = {}) =>
  sentAt(channel, time, n, { author: userObject(ME), ...extra })
