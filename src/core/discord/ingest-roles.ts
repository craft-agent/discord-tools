import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import type { Mirror } from "./mirror"
import { storedRole } from "./mirror-roles"

/**
 * Replaces a server's stored roles with `roles`, a whole role list as Discord
 * sent it, and records the ids of the user's own roles with the time of the
 * call. A role the list does not hold is deleted; an entry without a valid id
 * or permission bit set is skipped and counted.
 */
export function ingestRoleSnapshot(
  mirror: Mirror,
  ctx: IngestContext,
  server: string,
  roles: unknown[],
  ownRoles: readonly string[],
): IngestCounts {
  const counts = newCounts()
  const serverId = BigInt(server)
  const upsert = mirror.prepare(
    `INSERT INTO roles (id, server, name, position, permissions, managed, raw, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET server = excluded.server, name = excluded.name, position = excluded.position,
       permissions = excluded.permissions, managed = excluded.managed, raw = excluded.raw, updated = excluded.updated`,
  )
  const kept = new Set<bigint>()
  for (const entry of roles) {
    const role = storedRole(entry)
    if (role === null) {
      counts.skipped += 1
      continue
    }
    const id = BigInt(role.id)
    kept.add(id)
    upsert.run(
      id,
      serverId,
      role.name,
      role.position,
      role.permissions.toString(),
      role.managed ? 1 : 0,
      JSON.stringify(entry),
      ctx.now,
    )
    counts.stored += 1
  }

  const stale = mirror.prepare("SELECT id FROM roles WHERE server = ?")
  stale.setReadBigInts(true)
  const remove = mirror.prepare("DELETE FROM roles WHERE id = ?")
  for (const { id } of stale.all(serverId) as { id: bigint }[]) {
    if (kept.has(id)) continue
    remove.run(id)
    counts.deleted += 1
  }

  mirror
    .prepare(
      `INSERT INTO role_snapshots (server, own_roles, read_at) VALUES (?, ?, ?)
       ON CONFLICT (server) DO UPDATE SET own_roles = excluded.own_roles, read_at = excluded.read_at`,
    )
    .run(serverId, JSON.stringify([...new Set(ownRoles)]), ctx.now)
  return counts
}

/**
 * Expires a server's role snapshot by setting its read time to 0, so every role
 * write refuses it as out of date until the roles are read again. The stored
 * roles stay, since a role's members can still be listed against them. A server
 * without a snapshot is left alone and nothing is counted.
 */
export function expireRoleSnapshot(mirror: Mirror, server: string): IngestCounts {
  const counts = newCounts()
  const { changes } = mirror.prepare("UPDATE role_snapshots SET read_at = 0 WHERE server = ?").run(BigInt(server))
  counts.stored += Number(changes)
  return counts
}
