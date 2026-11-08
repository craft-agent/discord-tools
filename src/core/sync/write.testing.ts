import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ingestChannels, ingestServerList } from "../discord/ingest"
import { channelObject, ctxAt, CHANNEL, OTHER_CHANNEL, SERVER, serverObject } from "../discord/objects.testing"
import { SYNC_LIST_FILE } from "../discord/sync-list"
import type { SyncFixture } from "./read.testing"

/** Made-up ids of a second server and of channels of the two servers; all above 2^53. */
export const OTHER_SERVER = "1400000000000000101"
export const THIRD_CHANNEL = "1400000000000000202"
export const VOICE_CHANNEL = "1400000000000000203"
export const THREAD_CHANNEL = "1400000000000000204"
export const FORUM_CHANNEL = "1400000000000000205"
export const NEWS_CHANNEL = "1400000000000000206"
export const ELSEWHERE_CHANNEL = "1400000000000000207"

/** The `n`th made-up server id after `SERVER`, for lists that fill the limits. */
export function serverIdAfter(n: number): string {
  return String(BigInt(SERVER) + BigInt(n))
}

/** Seeds the mirror with two servers; `SERVER` has text, announcement, voice, thread and forum channels, `OTHER_SERVER` one text channel. */
export function seedGuilds(f: SyncFixture): void {
  f.seed((m) => {
    ingestServerList(m, ctxAt(f.now()), [serverObject(SERVER, { name: "Alpha" }), serverObject(OTHER_SERVER)])
    ingestChannels(
      m,
      ctxAt(f.now()),
      [
        channelObject(CHANNEL, { name: "general" }),
        channelObject(OTHER_CHANNEL, { name: "random" }),
        channelObject(THIRD_CHANNEL, { name: "memes" }),
        channelObject(VOICE_CHANNEL, { name: "voice", type: 2 }),
        channelObject(THREAD_CHANNEL, { name: "thread", type: 11 }),
        channelObject(FORUM_CHANNEL, { name: "forum", type: 15 }),
        channelObject(NEWS_CHANNEL, { name: "news", type: 5 }),
      ],
      SERVER,
    )
    ingestChannels(m, ctxAt(f.now()), [channelObject(ELSEWHERE_CHANNEL)], OTHER_SERVER)
  })
}

/** The sync list file exactly as it is on disk. */
export function listFileText(f: SyncFixture): Promise<string> {
  return readFile(join(f.paths.dir, SYNC_LIST_FILE), "utf8")
}
