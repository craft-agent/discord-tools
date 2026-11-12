import type { ChatSession } from "../chats/session"
import { intOrNull, textOrNull, type JsonRecord } from "../discord/ingest-values"
import type { StoredRole } from "../discord/mirror-roles"
import { listedRoles, rolesPath, type ListedRole } from "../people/role-list"
import { readLive } from "../people/request"
import { lookOnce } from "../threads/read-back"
import { serverReferer } from "./assign-read-back"

/** A role a read-back saw: its id, name and position. */
export type FoundRole = Pick<StoredRole, "id" | "name" | "position">

/** What the one look after an uncertain creation saw: the roles with exactly the name asked for, which are candidates and never a confirmation; or that it could not look (`failed`) or was cancelled first (`skipped`). */
export type CreateReadBack = { candidates: FoundRole[] } | "failed" | "skipped"

/** What the one look after an uncertain edit saw: whether the role is there and has every changed field as asked; or `failed` or `skipped`. */
export type EditReadBack = { present: boolean; as_asked: boolean } | "failed" | "skipped"

/** What the one look after an uncertain deletion saw: whether the role is still there; or `failed` or `skipped`. */
export type DeleteReadBack = { present: boolean } | "failed" | "skipped"

/** Every role of the server as Discord lists them now. */
async function listNow(session: ChatSession, server: string): Promise<ListedRole[]> {
  return listedRoles(await readLive(session, "GET", rolesPath(server), { referer: serverReferer(server) }))
}

/** Whether every field of `body` (the changed fields of an edit) stands in `role` as asked. */
function hasAsked(role: JsonRecord, body: JsonRecord): boolean {
  return Object.entries(body).every(([field, wanted]) => role[field] === wanted)
}

/** The one look after an uncertain creation: the server's roles named exactly `name`. */
export function readBackCreated(session: ChatSession, server: string, name: string): Promise<CreateReadBack> {
  return lookOnce(session, async () => ({
    candidates: (await listNow(session, server))
      .filter(({ role }) => role.name === name)
      .map(({ id, role }) => ({ id, name: textOrNull(role.name), position: intOrNull(role.position) ?? 0 })),
  }))
}

/** The one look after an uncertain edit: the role among the server's roles, and whether it has the changed fields as `body` asked. */
export function readBackEdited(
  session: ChatSession,
  server: string,
  role: string,
  body: JsonRecord,
): Promise<EditReadBack> {
  return lookOnce(session, async () => {
    const found = (await listNow(session, server)).find(({ id }) => id === role)
    return { present: found !== undefined, as_asked: found !== undefined && hasAsked(found.role, body) }
  })
}

/** The one look after an uncertain deletion: whether the role is among the server's roles. */
export function readBackDeleted(session: ChatSession, server: string, role: string): Promise<DeleteReadBack> {
  return lookOnce(session, async () => ({ present: (await listNow(session, server)).some(({ id }) => id === role) }))
}
