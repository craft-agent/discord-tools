import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHANNEL } from "../discord/objects.testing"
import { seedWorld } from "../search/search.testing"
import { invoke, type ToolContext } from "../tool"
import { discordExportCreate } from "./export-tool"
import { storeMessages, vouch } from "./export.testing"
import { createHistoryFixture } from "./history.testing"

/** The zone the tests write times in, so a file's name does not depend on the machine. */
export const ZONE = "UTC"

/** When the made-up messages were made: the time their ids carry (they share a millisecond). */
export const SENT_AT = "2025-12-15T05:42:19.697Z"

/** The day of the made-up messages in `ZONE`, as it is in the name of a file. */
export const DAY = "20251215"

/**
 * A signed-in label with the world of the search tests in its mirror and a
 * download directory of its own (not yet made), and a way to run
 * `discord_export_create`.
 */
export async function createExportFixture() {
  const f = await createHistoryFixture()
  seedWorld(f)
  const root = await mkdtemp(join(tmpdir(), "dsc-export-"))
  const downloadDir = join(root, "downloads")
  const ctx: ToolContext = { ...f.ctx, downloadDir, downloadMaxMb: 1 }
  return {
    ...f,
    ctx,
    downloadDir,
    /** The folder exports go to. */
    folder: join(downloadDir, "exports"),
    /** Runs `discord_export_create` as an entry point does: strict arguments, a result checked against its schema. */
    exportChat: (args: Record<string, unknown> = {}, context: ToolContext = ctx) =>
      invoke(discordExportCreate, { chat: CHANNEL, time_zone: ZONE, ...args }, context),
    /** Messages 1 to 10 of `CHANNEL`, vouched from the first to the last; 11 and 12 are stored past that edge. */
    seedTen(complete = false) {
      storeMessages(f, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      vouch(f, CHANNEL, 1, 10, complete)
    },
    dispose: async () => {
      await f.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

export type ExportFixture = Awaited<ReturnType<typeof createExportFixture>>
