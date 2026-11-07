import { mkdir, readdir, readFile, lstat } from "node:fs/promises"
import { join } from "node:path"
import { writeAccount } from "../discord/account-meta"
import { fakeToken } from "../discord/fake-token.testing"
import { ensureLabelDir } from "../discord/labels"
import { openMirrorForWrite, setMeta } from "../discord/mirror"
import { fakeHost, ok } from "../discord/service.testing"
import { LAST_SYNC_AT_META, SYNC_STATUS_META } from "../discord/sync-status"
import { writeTokenFile } from "../discord/token"
import type { ToolContext } from "../tool"
import { invoke } from "../tool"
import { discordAccountRead } from "./read"

export const NOW = 1_800_000_000_000
export const ACCOUNT_ID = "101234567890123456"

/** A local account plus a scheduler fake; neither a real scheduler nor Discord is reachable. */
export async function fixture(root: string, label = "default") {
  const stateDir = join(root, "state's directory")
  const paths = await ensureLabelDir(stateDir, label)
  await writeTokenFile(paths, fakeToken())
  await writeAccount(paths, { id: ACCOUNT_ID, name: "Example", verifiedAt: NOW - 1000 })
  const mirror = openMirrorForWrite(paths.mirror)
  setMeta(mirror, { account_id: ACCOUNT_ID, [LAST_SYNC_AT_META]: NOW - 1000, [SYNC_STATUS_META]: "complete" })
  mirror.close()
  const { host, calls } = fakeHost("darwin", root, () => ok("state = waiting"))
  const definition = join(root, "Library", "LaunchAgents")
  await mkdir(definition, { recursive: true })
  const ctx: ToolContext = {
    cwd: root,
    stateDir,
    runtime: {
      envPrefix: "EXAMPLE",
      cli: "/opt/example's cli",
      serviceId: "io.example.tools",
      env: {},
      serviceHost: host,
      now: () => NOW,
    },
  }
  return {
    paths,
    ctx,
    calls,
    read: (args: unknown = {}) => invoke(discordAccountRead, args, ctx),
    meta(values: Record<string, string | number | null>) {
      const db = openMirrorForWrite(paths.mirror)
      try {
        setMeta(db, values)
      } finally {
        db.close()
      }
    },
  }
}

/** File bytes and modes, excluding SQLite's permitted auxiliary WAL/shared-memory files. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) continue
    const path = join(root, entry.name)
    const stat = await lstat(path)
    result[path] = String(stat.mode)
    if (entry.isDirectory()) Object.assign(result, await snapshot(path))
    else if (entry.isFile()) result[path] += `:${(await readFile(path)).toString("base64")}`
  }
  return result
}
