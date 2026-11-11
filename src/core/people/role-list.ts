import { idText, isRecord, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"

/** Where Discord keeps a server's roles. */
export const rolesPath = (server: string) => `/guilds/${server}/roles`

/** A role of Discord's role list and its object. */
export type ListedRole = { id: string; role: JsonRecord }

/** The roles of Discord's role list: an array of objects, else `upstream_error`. An entry without a valid id is left out. */
export function listedRoles(value: unknown): ListedRole[] {
  if (!Array.isArray(value)) invalidResponse()
  return value.flatMap((entry): ListedRole[] => {
    if (!isRecord(entry)) invalidResponse()
    const id = idText(entry.id)
    return id === null ? [] : [{ id, role: entry }]
  })
}

/** A role and where it stands; `null` for one the server does not list. */
export type RankedRole = { id: string; position: number | null }

/** Orders roles by position, highest first, those the server does not list last, then by id as a number. */
export function byPositionThenId(a: RankedRole, b: RankedRole): number {
  if (a.position !== b.position) {
    if (a.position === null) return 1
    if (b.position === null) return -1
    return b.position - a.position
  }
  const [x, y] = [BigInt(a.id), BigInt(b.id)]
  return x === y ? 0 : x < y ? -1 : 1
}
