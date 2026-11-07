import type { IngestContext } from "./ingest-context"
import type { JsonRecord } from "./ingest-values"

/** Made-up ids, all above 2^53 (9007199254740992). */
export const ME = "1400000000000000001"
export const ALICE = "1400000000000000002"
export const BOB = "1400000000000000003"
export const SERVER = "1400000000000000100"
export const CHANNEL = "1400000000000000200"
export const OTHER_CHANNEL = "1400000000000000201"
export const DM = "1400000000000000300"

/** A fixed time for tests, in milliseconds. */
export const NOW = 1_800_000_000_000

/** A made-up message id: `n` above a base that exceeds 2^53, so ids order as `n` does. */
export function msgId(n: number): string {
  return String(1_450_000_000_000_000_000n + BigInt(n))
}

/** The ingest context of the test account, at `now`. */
export function ctxAt(now = NOW): IngestContext {
  return { me: ME, now }
}

/** A user object as Discord sends it. */
export function userObject(id: string, extra: JsonRecord = {}) {
  return { id, username: `user${id.slice(-2)}`, global_name: null, discriminator: "0", avatar: null, ...extra }
}

/** A server list entry as `/users/@me/guilds` sends it. */
export function serverObject(id: string, extra: JsonRecord = {}) {
  return { id, name: "Test server", icon: null, owner: false, permissions: "0", features: [], ...extra }
}

/** A channel as Discord sends it; type 0 is a server text channel. */
export function channelObject(id: string, extra: JsonRecord = {}) {
  return { id, type: 0, name: "general", ...extra }
}

/** A message in `channel` as the history endpoint sends it. */
export function messageObject(id: string, channel: string, extra: JsonRecord = {}) {
  return {
    id,
    channel_id: channel,
    type: 0,
    content: `text ${id.slice(-3)}`,
    author: userObject(ALICE),
    timestamp: "2026-01-01T00:00:00.000000+00:00",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 0,
    ...extra,
  }
}
