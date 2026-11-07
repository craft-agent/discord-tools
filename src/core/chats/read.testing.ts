import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isToolError, type ToolError } from "../errors"
import { createHarness, FAKE_TOKEN, TOKEN_VARIABLE } from "../discord/client.testing"
import type { IngestContext } from "../discord/ingest"
import { inTransaction, openMirrorForRead, openMirrorForWrite, setMeta, type Mirror } from "../discord/mirror"
import { ACCOUNT_ID_META } from "../discord/mirror-meta"
import { ME } from "../discord/objects.testing"
import { fakeHost } from "../discord/service.testing"
import { invoke, type ToolContext } from "../tool"
import { discordChatRead } from "./read"

/** The variable prefix of `TOKEN_VARIABLE`, which the harness reads its token from. */
const ENV_PREFIX = "EXAMPLE"

/** A signed-in label with a mirror, a fake Discord behind the one HTTP client, and a clock that moves only when the client sleeps. */
export async function createChatFixture() {
  const h = await createHarness()
  await h.warm()
  const mirror = openMirrorForWrite(h.paths.mirror)
  setMeta(mirror, { [ACCOUNT_ID_META]: ME })
  mirror.close()
  const ctx: ToolContext = {
    cwd: h.stateDir,
    stateDir: h.stateDir,
    runtime: {
      envPrefix: ENV_PREFIX,
      cli: "example-cli",
      serviceId: "io.example.tools",
      env: { [TOKEN_VARIABLE]: FAKE_TOKEN },
      serviceHost: fakeHost("darwin", h.stateDir).host,
      now: h.now,
      discord: {
        transport: (request) => {
          h.sentAt.push(h.now())
          return h.discord.transport(request)
        },
        os: "macos",
        sleep: async (ms) => {
          h.sleeps.push(ms)
          h.advance(ms)
        },
        random: () => 0.5,
      },
    },
  }
  return {
    ...h,
    ctx,
    /** Runs `discord_chat_read` as an entry point does: strict arguments, a result checked against its schema. */
    read: (args: unknown) => invoke(discordChatRead, args, ctx),
    /** The ingest context of the moment, for seeding the mirror. */
    ingestContext: (): IngestContext => ({ me: ME, now: h.now() }),
    /** Seeds the mirror in one transaction, as a sync run would (ingest functions and `markCurrent` only). */
    seed<T>(fn: (mirror: Mirror) => T): T {
      const db = openMirrorForWrite(h.paths.mirror)
      try {
        return inTransaction(db, () => fn(db))
      } finally {
        db.close()
      }
    },
    /** Reads the mirror on a read-only connection. */
    inspect<T>(fn: (mirror: Mirror) => T): T {
      const db = openMirrorForRead(h.paths.mirror)
      try {
        return fn(db)
      } finally {
        db.close()
      }
    },
    /** Writes the label's sync list. */
    writeSyncList: (list: unknown) => writeFile(join(h.paths.dir, "sync.json"), JSON.stringify(list)),
  }
}

export type ChatFixture = Awaited<ReturnType<typeof createChatFixture>>

/** The tool error a call fails with; fails when the call succeeds. */
export async function failure(call: Promise<unknown>): Promise<ToolError> {
  try {
    await call
  } catch (error) {
    if (isToolError(error)) return error
    throw error
  }
  throw new Error("expected the call to fail")
}
