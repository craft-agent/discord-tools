import { newCounts, type IngestContext, type IngestCounts } from "./ingest-context"
import type { Mirror } from "./mirror"
import { storedRole, type StoredRole } from "./mirror-roles"

/** Prepares the store of one role of a server as Discord sent it, whole in `raw`, over the one stored under its id. */
function roleUpsert(mirror: Mirror) {
  const upsert = mirror.prepare(
    `INSERT INTO roles (id, server, name, position, permissions, managed, raw, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET server = excluded.server, name = excluded.name, position = excluded.position,
       permissions = excluded.permissions, managed = excluded.managed, raw = excluded.raw, updated = excluded.updated`,
  )
  return (server: bigint, role: StoredRole, entry: unknown, now: number) =>
    upsert.run(
      BigInt(role.id),
      server,
      role.name,
      role.position,
      role.permissions.toString(),
      role.managed ? 1 : 0,
      JSON.stringify(entry),
      now,
    )
}

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
  const upsert = roleUpsert(mirror)
  const kept = new Set<bigint>()
  for (const entry of roles) {
    const role = storedRole(entry)
    if (role === null) {
      counts.skipped += 1
      continue
    }
    kept.add(BigInt(role.id))
    upsert(serverId, role, entry, ctx.now)
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
 * Stores one role of a server as Discord sent it, over the one stored under its
 * id, without changing when the snapshot was read: a role a write created or
 * changed, which the snapshot's next read will confirm. An entry without a
 * valid id or permission bit set is skipped and counted.
 */
export function ingestRole(mirror: Mirror, ctx: IngestContext, server: string, entry: unknown): IngestCounts {
  const counts = newCounts()
  const role = storedRole(entry)
  if (role === null) {
    counts.skipped += 1
    return counts
  }
  roleUpsert(mirror)(BigInt(server), role, entry, ctx.now)
  counts.stored += 1
  return counts
}

/**
 * Removes one role from a server's stored roles, without changing when the
 * snapshot was read. A role the server does not store is left alone and
 * nothing is counted.
 */
export function ingestRoleRemoval(mirror: Mirror, server: string, role: string): IngestCounts {
  const counts = newCounts()
  const { changes } = mirror.prepare("DELETE FROM roles WHERE id = ? AND server = ?").run(BigInt(role), BigInt(server))
  counts.deleted += Number(changes)
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
