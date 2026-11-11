import { UNTRUSTED_NOTE } from "../chats/format"
import { intOrNull, isRecord, textOrNull, type JsonRecord } from "../discord/ingest-values"
import { invalidResponse } from "../discord/sync-page"
import { type ErrorCode, isToolError } from "../errors"
import { countOrNull } from "../people/count"
import { readLive } from "../people/request"
import { byPositionThenId, listedRoles, rolesPath } from "../people/role-list"
import { checkServer } from "../search/scope"
import type { RoleItem, ServerHandler } from "./schemas"

/** Where Discord counts how many members hold each role of a server. */
export const roleCountsPath = (server: string) => `${rolesPath(server)}/member-counts`

/** The error codes of a refused count request that leave the list of roles standing. */
const COUNTS_REFUSED: readonly ErrorCode[] = ["forbidden", "not_found"]

/** The largest color a role has: three bytes, `#ffffff`. */
const COLOR_MAX = 0xffffff

/** What the result of `roles` tells about its order, the counts, whose words the names are and what was stored. */
const ROLES_NOTE =
  "Every role of one server, highest first, read from Discord once; `members` is how many members hold the role as Discord counts them, null when it gives no count (`counts_missing` when it refused the counts). Role names are written by the server's admins. Nothing was stored in the local mirror."

/** A role's color as `#rrggbb`; `null` for none (0) or a number that is no color. */
function colorOrNull(value: unknown): string | null {
  const color = intOrNull(value)
  return color === null || color <= 0 || color > COLOR_MAX ? null : `#${color.toString(16).padStart(6, "0")}`
}

/** The role's item; `members` is its count, or `null`. */
function roleItem(role: JsonRecord, id: string, server: string, members: number | null): RoleItem {
  return {
    id,
    name: textOrNull(role.name),
    position: intOrNull(role.position) ?? 0,
    color: colorOrNull(role.color),
    hoist: role.hoist === true,
    mentionable: role.mentionable === true,
    managed: role.managed === true,
    everyone: id === server,
    members,
    permissions: textOrNull(role.permissions),
  }
}

/** The member count of Discord's answer by role id: an object, else `upstream_error`. */
function countsOf(value: unknown): JsonRecord {
  if (!isRecord(value)) invalidResponse()
  return value
}

/**
 * Method `roles`: every role of a server with how many members hold it, from
 * the role list and the member counts, asked one after the other. A refusal of
 * the counts alone leaves the roles listed, with no counts. The server is
 * checked against the mirror before any request; nothing is stored.
 */
export const readRoles: ServerHandler = async (session, args) => {
  const server = args.server
  checkServer(session, server)
  const list = await readLive(session, "GET", rolesPath(server))
  const roles = listedRoles(list)
  const counts = await readLive(session, "GET", roleCountsPath(server)).then(countsOf, (error: unknown) => {
    if (isToolError(error) && COUNTS_REFUSED.includes(error.code)) return null
    throw error
  })
  const items = roles
    .map(({ id, role }) => roleItem(role, id, server, counts === null ? null : countOrNull(counts[id])))
    .sort(byPositionThenId)
  return {
    note: `${ROLES_NOTE} ${UNTRUSTED_NOTE}`,
    roles: items,
    count: items.length,
    counts_missing: counts === null,
  }
}
