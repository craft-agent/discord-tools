import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ToolError } from "../errors"
import { readAccount } from "./account-meta"
import type { DiscordClientOptions, DiscordClient } from "./client"
import { isRecord, type JsonRecord } from "./ingest-values"
import { ACCOUNT_ID_META } from "./mirror-meta"
import { isSnowflake } from "./snowflake"
import { checkAbort } from "./sync-channels"
import { invalidResponse } from "./sync-page"

/**
 * Reads the account a mirror is bound to without creating or migrating it,
 * whatever its schema version, so an older mirror never stands between an
 * account and signing in or syncing again.
 */
export function existingBinding(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  // Query-only permits SQLite to reopen a WAL mirror whose last writer removed its shared-memory file.
  const mirror = new DatabaseSync(path)
  try {
    mirror.exec("PRAGMA query_only = ON")
    if (!mirror.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return undefined
    const row = mirror.prepare("SELECT value FROM meta WHERE key = ?").get(ACCOUNT_ID_META) as
      { value: string } | undefined
    return row?.value
  } finally {
    mirror.close()
  }
}

/** Checks both durable account bindings before any fetched record is stored. */
export async function verifySyncIdentity(
  client: DiscordClient,
  options: DiscordClientOptions & { signal?: AbortSignal },
): Promise<JsonRecord & { id: string }> {
  const account = await readAccount(options.paths)
  const binding = existingBinding(options.paths.mirror)
  checkAbort(options.signal)
  const user = await client.read("GET", "/users/@me", { signal: options.signal })
  checkAbort(options.signal)
  if (!isRecord(user) || !isSnowflake(user.id) || typeof user.username !== "string" || user.username.length === 0)
    invalidResponse()
  if ((account && account.id !== user.id) || (binding !== undefined && binding !== user.id)) {
    throw new ToolError("unauthenticated", "The signed-in account does not match this label's account binding.")
  }
  return { ...user, id: user.id }
}
