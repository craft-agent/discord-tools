import type { ChatSession } from "../chats/session"
import { ingestRoleSnapshot } from "../discord/ingest"
import { isRecord, type JsonRecord } from "../discord/ingest-values"
import { type RoleSnapshot, serverOwned, storedRole } from "../discord/mirror-roles"
import { invalidResponse } from "../discord/sync-page"
import { memberFields } from "../people/member-fields"
import { explainRefusal, readLive } from "../people/request"
import { byPositionThenId, listedRoles, rolesPath } from "../people/role-list"
import { checkServer } from "../search/scope"
import { readRoleCounts } from "../servers/roles"
import { StepErrors } from "../tool"
import { type Standing, standingOf } from "./standing"

/** Where Discord keeps the user's own membership of a server. */
export const ownMemberPath = (server: string) => `/users/@me/guilds/${server}/member`

/** Everything `list` and `role` need from one reading of a server's roles. */
export type LiveRoles = {
  /** The roles and the user's own role ids as just read, and as stored. */
  snapshot: RoleSnapshot
  /** Each listed role as Discord sent it, by id. */
  objects: ReadonlyMap<string, JsonRecord>
  /** How many members hold each role by id; `null` when Discord refused the counts. */
  counts: JsonRecord | null
  standing: Standing
  /** The steps that failed after the roles were read. */
  steps: StepErrors
}

/**
 * Reads a server's roles, their member counts and the user's own membership,
 * one request after the other, and stores the roles and the user's role ids as
 * the server's snapshot. The server is checked against the mirror before any
 * request. A refusal of the counts alone leaves the roles read, with no counts;
 * a failure to store is recorded in `steps` and leaves the read standing.
 */
export async function readLiveRoles(session: ChatSession, server: string): Promise<LiveRoles> {
  checkServer(session, server)
  const listed = listedRoles(await readLive(session, "GET", rolesPath(server)))
  const counts = await readRoleCounts(session, server)
  const member = await readLive(session, "GET", ownMemberPath(server)).catch((error: unknown) =>
    explainRefusal(error, { not_found: `The user is not a member of server ${server}.` }),
  )
  if (!isRecord(member)) invalidResponse()
  const ownRoles = memberFields(member).roles

  const readAt = session.now()
  const roles = listed.flatMap(({ role }) => storedRole(role) ?? []).sort(byPositionThenId)
  const snapshot: RoleSnapshot = { server, roles, ownRoles, readAt }
  const steps = new StepErrors()
  await steps.record("store", async () =>
    session.store((ctx) =>
      ingestRoleSnapshot(
        session.mirror,
        { ...ctx, now: readAt },
        server,
        listed.map(({ role }) => role),
        ownRoles,
      ),
    ),
  )
  return {
    snapshot,
    objects: new Map(listed.map(({ id, role }) => [id, role])),
    counts,
    standing: standingOf(snapshot, serverOwned(session.mirror, server)),
    steps,
  }
}
