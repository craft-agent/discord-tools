import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createHarness } from "../discord/client.testing"
import { inTransaction, openMirrorForWrite, type Mirror } from "../discord/mirror"
import { fakeHost } from "../discord/service.testing"
import { invoke, type ToolContext } from "../tool"
import { discordSyncAdd } from "./add"
import { discordSyncRead } from "./read"

/** A signed-in label with no mirror yet, and a clock the test moves; nothing here reaches a network. */
export async function createSyncFixture() {
  const h = await createHarness()
  const ctx: ToolContext = {
    cwd: h.stateDir,
    stateDir: h.stateDir,
    runtime: {
      envPrefix: "EXAMPLE",
      cli: "example-cli",
      serviceId: "io.example.tools",
      env: {},
      serviceHost: fakeHost("darwin", h.stateDir).host,
      now: h.now,
    },
  }
  return {
    ...h,
    ctx,
    /** Runs `discord_sync_read` as an entry point does: strict arguments, a result checked against its schema. */
    read: (args: unknown) => invoke(discordSyncRead, args, ctx),
    /** Runs `discord_sync_add` as an entry point does. */
    add: (args: unknown) => invoke(discordSyncAdd, args, ctx),
    /** Creates the mirror and seeds it in one transaction (ingest functions and `markCurrent` only). */
    seed<T>(fn: (mirror: Mirror) => T): T {
      const db = openMirrorForWrite(h.paths.mirror)
      try {
        return inTransaction(db, () => fn(db))
      } finally {
        db.close()
      }
    },
    /** Writes the label's sync list file as it is given. */
    writeSyncList: (list: unknown) => writeFile(join(h.paths.dir, "sync.json"), JSON.stringify(list)),
  }
}

export type SyncFixture = Awaited<ReturnType<typeof createSyncFixture>>
