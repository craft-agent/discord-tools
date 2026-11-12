import { z } from "zod"
import { ingestChannels } from "../discord/ingest"
import { channelRecords, invalidResponse } from "../discord/sync-page"
import type { MirroredChannel } from "./channel-target"
import type { ChatSession } from "./session"
import { type TagItem, tagItem } from "./thread-schemas"

const storedForum = z.object({ tags: z.array(tagItem) })

/** The tags in a stored `forum` JSON; `null` when the column is empty or is not shaped as expected. */
export function storedTags(json: string | null): TagItem[] | null {
  if (json === null) return null
  try {
    const parsed = storedForum.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data.tags : null
  } catch {
    return null
  }
}

/**
 * The tags a forum or media channel offers. They come from the mirror; when
 * the channel was stored without them, the channel is read from Discord once
 * and stored, and whatever tags it then holds are used (none when it has none).
 */
export async function forumTags(session: ChatSession, parent: MirroredChannel): Promise<TagItem[]> {
  const known = storedTags(parent.forum)
  if (known) return known
  const { id, referer } = parent.target
  const [channel] = channelRecords(
    [
      await session.client().read("GET", `/channels/${id}`, {
        referer,
        ...(session.signal ? { signal: session.signal } : {}),
      }),
    ],
    parent.server ?? undefined,
  )
  if (channel?.id !== id) invalidResponse()
  session.store((ctx) => ingestChannels(session.mirror, ctx, [channel], parent.server ?? undefined))
  const row = session.mirror.prepare("SELECT forum FROM channels WHERE id = ?").get(BigInt(id)) as
    { forum: string | null } | undefined
  return storedTags(row?.forum ?? null) ?? []
}
