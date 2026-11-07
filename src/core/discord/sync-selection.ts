import { BudgetSpent } from "./client"
import { ToolError } from "../errors"
import { ingestChannels, ingestDmList, ingestServerList } from "./ingest"
import type { JsonRecord } from "./ingest-values"
import { inTransaction } from "./mirror"
import { checkAbort, type SyncChannel, type SyncContext } from "./sync-channels"
import { WHOLE_SERVER_CHANNELS, type SyncList, type SyncServer } from "./sync-list"
import { channelRecords, idRecords, invalidResponse, PRIVATE_CHANNEL_TYPES } from "./sync-page"

const SERVER_TEXT_TYPES = [0, 5, 10, 11, 12]

function channel(row: JsonRecord): SyncChannel {
  return { id: row.id as string, head: row.last_message_id as string | null | undefined }
}

/**
 * The channels of one server a sync run follows, from that server's channel
 * list: the named ones, or the most active supported text channels of a whole
 * server, never an excluded one. `unknown` is told once per named channel the
 * list lacks.
 */
export function pickServerChannels(rows: JsonRecord[], selection: SyncServer, unknown?: () => void): JsonRecord[] {
  const excluded = new Set(selection.exclude)
  const supported = rows.filter(
    (row) => SERVER_TEXT_TYPES.includes(row.type as number) && !excluded.has(row.id as string),
  )
  if (selection.channels) {
    const byId = new Map(supported.map((row) => [row.id as string, row]))
    const picked: JsonRecord[] = []
    for (const id of selection.channels) {
      if (excluded.has(id)) continue
      const row = byId.get(id)
      if (row) picked.push(row)
      else unknown?.()
    }
    return picked
  }
  return supported
    .sort((a, b) => {
      const left = BigInt((a.last_message_id as string | null | undefined) ?? "0")
      const right = BigInt((b.last_message_id as string | null | undefined) ?? "0")
      return left === right ? 0 : left > right ? -1 : 1
    })
    .slice(0, WHOLE_SERVER_CHANNELS)
}

/** Fetches only known selected servers and always follows the account's private channels. */
export async function selectChannels(
  ctx: SyncContext,
  list: SyncList,
  partial: (reason: string, skipped?: number) => void,
): Promise<SyncChannel[]> {
  const read = async (path: string) => {
    checkAbort(ctx.signal)
    const result = await ctx.client.read("GET", path, { signal: ctx.signal })
    checkAbort(ctx.signal)
    return result
  }
  const dms = channelRecords(await read("/users/@me/channels")).filter((row) =>
    PRIVATE_CHANNEL_TYPES.includes(row.type as number),
  )
  ctx.add(inTransaction(ctx.mirror, () => ingestDmList(ctx.mirror, { me: ctx.me, now: ctx.now() }, dms)))
  const selected = new Map(dms.map((row) => [row.id as string, channel(row)]))
  if (!list.servers.length) return [...selected.values()]
  const servers = idRecords(await read("/users/@me/guilds"))
  ctx.add(inTransaction(ctx.mirror, () => ingestServerList(ctx.mirror, { me: ctx.me, now: ctx.now() }, servers)))
  const known = new Set(servers.map((server) => server.id))
  for (const selection of list.servers) {
    if (!known.has(selection.id)) {
      partial("unknown_server", selection.channels?.length ?? 1)
      continue
    }
    try {
      const rows = channelRecords(await read(`/guilds/${selection.id}/channels`), selection.id)
      // A private channel cannot become a server target through a contradictory response.
      if (rows.some((row) => selected.has(row.id as string))) invalidResponse()
      ctx.add(
        inTransaction(ctx.mirror, () => ingestChannels(ctx.mirror, { me: ctx.me, now: ctx.now() }, rows, selection.id)),
      )
      const picked = pickServerChannels(rows, selection, () => partial("unknown_channel", 1))
      for (const row of picked) selected.set(row.id as string, channel(row))
    } catch (error) {
      if (
        error instanceof BudgetSpent ||
        ctx.signal?.aborted ||
        !(error instanceof ToolError) ||
        error.code === "unauthenticated"
      )
        throw error
      partial(error.code, 1)
    }
  }
  return [...selected.values()]
}
