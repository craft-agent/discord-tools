import { idText, idTexts, intOrNull, isRecord, textOrNull } from "./ingest-values"
import type { Mirror } from "./mirror"

/** How long a role snapshot may be relied on for a role write, in milliseconds: roles change without a trace a user account can poll. */
export const ROLE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

/** Discord's permission bit sets are decimal text of up to 20 digits, a 64-bit number. */
const PERMISSIONS_TEXT = /^\d{1,20}$/

/** A role of a stored snapshot; `permissions` is the bit set as the BigInt that keeps every bit exact. */
export type StoredRole = {
  id: string
  name: string | null
  position: number
  permissions: bigint
  managed: boolean
}

/** One server's roles and the user's own role ids, with when they were read. */
export type RoleSnapshot = {
  server: string
  /** Every role of the server, highest first, then by id. */
  roles: StoredRole[]
  /** The ids of the roles the user holds; the @everyone role (the server's own id) is not among them. */
  ownRoles: string[]
  readAt: number
}

/** The role a Discord role object says; `null` for an entry without a valid id or a permission bit set. */
export function storedRole(entry: unknown): StoredRole | null {
  if (!isRecord(entry)) return null
  const id = idText(entry.id)
  if (id === null || typeof entry.permissions !== "string" || !PERMISSIONS_TEXT.test(entry.permissions)) return null
  return {
    id,
    name: textOrNull(entry.name),
    position: intOrNull(entry.position) ?? 0,
    permissions: BigInt(entry.permissions),
    managed: entry.managed === true,
  }
}

/** Whether the user owns the server, as the mirror's server row last said; a server it holds no owner flag of is not owned. */
export function serverOwned(mirror: Mirror, server: string): boolean {
  const row = mirror.prepare("SELECT owner FROM servers WHERE id = ?").get(BigInt(server)) as
    { owner: number | null } | undefined
  return row?.owner === 1
}

type RoleRow = { id: string; name: string | null; position: number; permissions: string; managed: number }

/** The snapshot stored for a server, or `null` when none was ever stored. */
export function readRoleSnapshot(mirror: Mirror, server: string): RoleSnapshot | null {
  const snapshot = mirror
    .prepare("SELECT own_roles, read_at FROM role_snapshots WHERE server = ?")
    .get(BigInt(server)) as { own_roles: string; read_at: number } | undefined
  if (snapshot === undefined) return null
  const rows = mirror
    .prepare(
      "SELECT CAST(id AS TEXT) AS id, name, position, permissions, managed FROM roles WHERE server = ? ORDER BY position DESC, id",
    )
    .all(BigInt(server)) as RoleRow[]
  return {
    server,
    roles: rows.map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      permissions: BigInt(row.permissions),
      managed: row.managed === 1,
    })),
    ownRoles: idTexts(JSON.parse(snapshot.own_roles)),
    readAt: snapshot.read_at,
  }
}
