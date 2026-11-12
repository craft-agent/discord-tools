import { userLookup } from "../chats/dms"
import { displayName } from "../chats/format"
import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import { expireRoleSnapshot } from "../discord/ingest"
import { isRecord } from "../discord/ingest-values"
import { serverOwned } from "../discord/mirror-roles"
import { isAbortError, isToolError, ToolError } from "../errors"
import { rolesPath } from "../people/role-list"
import { StepErrors, type ToolContext } from "../tool"
import { checkFresh, checkRoleWrite, checkUsers, findRole, requireSnapshot } from "./assign-check"
import { readBackRole, serverReferer } from "./assign-read-back"
import {
  type RoleAssignInput,
  type RoleAssignResult,
  type RoleUnassignInput,
  type RoleWriteInput,
} from "./assign-schemas"

/** Where Discord keeps one member's hold on one role: `PUT` gives it, `DELETE` takes it. */
export const memberRolePath = (server: string, user: string, role: string) =>
  `/guilds/${server}/members/${user}/roles/${role}`

/** Where Discord gives a role to several members at once (`PATCH` with `member_ids`). */
export const bulkRolePath = (server: string, role: string) => `${rolesPath(server)}/${role}/members`

/** What a result says when the role was given. */
export const ROLE_GIVEN_NOTE =
  "Discord accepted the change: the members now hold the role (giving it to a member who already held it changes nothing). The server's audit log names the user as the one who gave it, with the reason when one was sent. Discord may still have refused members who left the server (`applied` and `not_applied` say so when Discord listed whom it changed). The local mirror holds no member roles, so nothing about them was stored."

/** What a result says when the role was taken away. */
export const ROLE_TAKEN_NOTE =
  "Discord accepted the change: the member no longer holds the role (taking it from a member who lacked it changes nothing). The server's audit log names the user as the one who took it, with the reason when one was sent. The local mirror holds no member roles, so nothing about them was stored."

/** What an `uncertain` role write says: it may have landed, `details.read_back` is the look, and nothing was sent again. */
const UNCERTAIN_MESSAGE =
  "The change of the role may have reached Discord, and it was not sent again. `details.read_back` says what one look saw: for one user `has_role` true or false, for several `holders` (the named users Discord lists as holding the role) and `capped` (the list holds at most 100 ids, so a user missing from a capped list is unknown), and `failed` or `skipped` means it could not look. Check the member's roles (discord_people_read method member) before changing them again, and ask the user first: giving or taking a role twice changes nothing further."

/** One role write: who is changed and in which direction. */
type RoleChange = { input: RoleWriteInput; users: string[]; give: boolean }

/** The one request of a change: a single user is a `PUT` or `DELETE` on the member, several users one `PATCH` on the role. */
function requestOf({ input: { server, role }, users, give }: RoleChange) {
  if (!give) return { method: "DELETE", path: memberRolePath(server, users[0]!, role) }
  if (users.length === 1) return { method: "PUT", path: memberRolePath(server, users[0]!, role) }
  return { method: "PATCH", path: bulkRolePath(server, role), body: { member_ids: users } }
}

/** Sends the change once and returns Discord's answer, `undefined` for an empty one. */
function send(session: ChatSession, change: RoleChange): Promise<unknown> {
  const { method, path, body } = requestOf(change)
  return session.client().write(method, path, {
    referer: serverReferer(change.input.server),
    ...(body === undefined ? {} : { body }),
    ...(change.input.reason === undefined ? {} : { reason: change.input.reason }),
    ...(session.signal ? { signal: session.signal } : {}),
  })
}

/**
 * Expires the server's snapshot through the ingest when the change reaches the
 * user's own roles, so the next role write reads them again. A failure to store
 * is recorded in `steps` and never hides the outcome of the write.
 */
async function expireOwnSnapshot(session: ChatSession, { input, users }: RoleChange, steps: StepErrors) {
  if (!users.includes(session.me)) return
  await steps.record("snapshot", async () => session.store(() => expireRoleSnapshot(session.mirror, input.server)))
}

/**
 * Gives a role to the users, or takes it from the one, after the checks of
 * `assign-check` against the stored roles and before any request. The request
 * is sent once and never retried: a refusal or a connection never made is
 * thrown as it is, anything else is `uncertain` after one read-back. A change
 * that reaches the user's own roles expires the snapshot, done or uncertain.
 */
async function changeRole(change: RoleChange, ctx: ToolContext): Promise<RoleAssignResult> {
  const { input, users, give } = change
  const session = await openChatSession(input, ctx)
  try {
    const snapshot = requireSnapshot(session, input.server)
    checkFresh(snapshot, session.now())
    const role = findRole(snapshot, input.role)
    checkRoleWrite(snapshot, role, serverOwned(session.mirror, input.server), give)
    checkUsers(session, users)
    const user = userLookup(session.mirror)
    const members = users.map((id) => ({ id, name: displayName(user(id)) }))
    const steps = new StepErrors()
    checkAbort(session.signal)

    let answer: unknown
    try {
      answer = await send(session, change)
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isToolError(error) && error.code !== "uncertain") throw error
      await expireOwnSnapshot(session, change, steps)
      throw new ToolError("uncertain", UNCERTAIN_MESSAGE, {
        ...(error instanceof Error ? { cause: error } : {}),
        details: { read_back: await readBackRole(session, input.server, input.role, users) },
      })
    }
    await expireOwnSnapshot(session, change, steps)

    const changed = give && users.length > 1 && isRecord(answer) ? answer : undefined
    const applied = changed && users.filter((id) => Object.hasOwn(changed, id))
    return {
      server: input.server,
      role: { id: role.id, name: role.name },
      members,
      given: give,
      ...(applied ? { applied, not_applied: users.filter((id) => !applied.includes(id)) } : {}),
      note: give ? ROLE_GIVEN_NOTE : ROLE_TAKEN_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}

/** Gives a role to 1 to 30 users: one `PUT`, or one bulk `PATCH` for several. */
export function assignRole(input: RoleAssignInput, ctx: ToolContext): Promise<RoleAssignResult> {
  return changeRole({ input, users: input.users, give: true }, ctx)
}

/** Takes a role from one user. */
export function unassignRole(input: RoleUnassignInput, ctx: ToolContext): Promise<RoleAssignResult> {
  return changeRole({ input, users: [input.user], give: false }, ctx)
}
