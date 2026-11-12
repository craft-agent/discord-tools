import { checkAbort, openChatSession, type ChatSession } from "../chats/session"
import type { IngestContext } from "../discord/ingest-context"
import { expireRoleSnapshot, ingestRole, ingestRoleRemoval } from "../discord/ingest"
import { readRoleRaw, serverOwned, storedRole, type RoleSnapshot, type StoredRole } from "../discord/mirror-roles"
import { StepErrors, type ToolContext } from "../tool"
import { checkCanManageRoles, checkHandOut, checkManageable, findRole, freshSnapshot } from "./assign-check"
import {
  checkEveryoneEdit,
  createBits,
  createRequest,
  deleteRequest,
  editBits,
  editRequest,
  planEdit,
} from "./manage-plan"
import { readBackCreated, readBackDeleted, readBackEdited } from "./manage-read-back"
import type {
  RoleCreateInput,
  RoleCreateResult,
  RoleDeleteInput,
  RoleDeleteResult,
  RoleEditInput,
  RoleEditResult,
} from "./manage-schemas"
import { permissionNames } from "./permissions"
import { type SentRoleWrite, sendRoleWrite, storeInSnapshot, uncertainRoleWrite } from "./role-write"

/** What a result says when the role was created and the snapshot holds it. */
export const ROLE_CREATED_NOTE =
  "Discord created the role and it is stored with the server's roles, at the position Discord gave it (a new role stands at the bottom, above @everyone). Nobody holds it yet: give it with discord_role_assign. The server's audit log names the user as its creator, with the reason when one was sent. Everyone in the server sees its name."

/** What a result says when the role was edited and the snapshot follows the change. */
export const ROLE_EDITED_NOTE =
  "Discord accepted the edit and the stored roles hold the role as it answered. The server's audit log names the user as the one who changed it, with the reason when one was sent."

/** What a result says when the edit reached a role the user holds, so the stored roles are expired. */
export const ROLE_EDITED_HELD_NOTE =
  "Discord accepted the edit. The user holds this role (or it is @everyone), so the change may reach the user's own permissions: the stored roles are expired, and the next role change needs them read again with discord_role_read method list. The server's audit log names the user as the one who changed it, with the reason when one was sent."

/** What a result says when the role was deleted and the snapshot no longer holds it. */
export const ROLE_DELETED_NOTE =
  "Discord deleted the role. It left everyone who held it, nothing brings it back, and the stored roles no longer hold it. The server's audit log names the user as the one who deleted it, with the reason when one was sent."

/** What a result says when the deleted role was one the user held, so the stored roles are expired. */
export const ROLE_DELETED_HELD_NOTE =
  "Discord deleted the role. It left everyone who held it, and nothing brings it back. The user held it, so the stored roles are expired: the next role change needs them read again with discord_role_read method list. The server's audit log names the user as the one who deleted it, with the reason when one was sent."

/** What an `uncertain` creation says: the role may exist, `details.read_back` is the look, and nothing was sent again. */
const CREATE_UNCERTAIN_MESSAGE =
  "The role may have been created, and the request was not sent again. `details.read_back.candidates` lists the roles a look at the server's roles saw with exactly that name: they are candidates, never a confirmation (a role of that name may have existed before), and an empty list does not prove there is none. `failed` or `skipped` means it could not look. Nothing was stored. Check with discord_role_read method list before creating again: a repeat can leave two roles."

/** What an `uncertain` edit says. */
const EDIT_UNCERTAIN_MESSAGE =
  "The edit may have reached Discord, and it was not sent again. `details.read_back` says what one look at the server's roles saw: `present` (the role is listed) and `as_asked` (it has every changed field as asked), and `failed` or `skipped` means it could not look. Read the role again with discord_role_read method role before editing it again, and ask the user first."

/** What an `uncertain` deletion says. */
const DELETE_UNCERTAIN_MESSAGE =
  "The deletion may have reached Discord, and it was not sent again. `details.read_back.present` says whether one look at the server's roles still listed the role, and `failed` or `skipped` means it could not look. Read the roles again with discord_role_read method list before deleting it again, and ask the user first."

/** Whether the user holds the role, @everyone included: a change to it may reach the user's own permissions. */
function userHolds(snapshot: RoleSnapshot, role: StoredRole): boolean {
  return role.id === snapshot.server || snapshot.ownRoles.includes(role.id)
}

/** The role Discord answered a write with and its object as sent; `null` when there is no answer, or it is another role's than `id`. */
function answeredRole(sent: SentRoleWrite, id?: string): { role: StoredRole; answer: unknown } | null {
  if (sent.kind !== "answered") return null
  const role = storedRole(sent.answer)
  return role !== null && (id === undefined || role.id === id) ? { role, answer: sent.answer } : null
}

/** The failure that made a write's outcome unclear, when there is one. */
const causeOf = (sent: SentRoleWrite) => (sent.kind === "unclear" ? sent.cause : undefined)

/** Expires the server's snapshot through the ingest, so the next role write reads the user's roles again. */
function expireSnapshot(session: ChatSession, steps: StepErrors, server: string): Promise<void> {
  return storeInSnapshot(session, steps, () => expireRoleSnapshot(session.mirror, server))
}

/**
 * Follows a done change in the snapshot through `change`; a change to a role
 * the user holds expires the snapshot instead, since it may reach the user's
 * own permissions.
 */
function followInSnapshot(
  session: ChatSession,
  steps: StepErrors,
  server: string,
  held: boolean,
  change: (ctx: IngestContext) => unknown,
): Promise<void> {
  return held ? expireSnapshot(session, steps, server) : storeInSnapshot(session, steps, change)
}

/**
 * Creates a role after the checks against the stored roles and before any
 * request: the user may manage roles, and the permissions are neither
 * `administrator` nor ones the user lacks. The request is sent once and never
 * retried: a refusal or a connection never made is thrown as it is, anything
 * else, and an answer that is not the new role, is `uncertain` after one read
 * of the server's roles, with nothing stored. The role Discord returns goes
 * into the snapshot without changing when it was read.
 */
export async function createRole(input: RoleCreateInput, ctx: ToolContext): Promise<RoleCreateResult> {
  const bits = createBits(input)
  const session = await openChatSession(input, ctx)
  try {
    const snapshot = freshSnapshot(session, input.server)
    const standing = checkCanManageRoles(snapshot, serverOwned(session.mirror, input.server))
    checkHandOut(standing, bits, "The new role would hold")
    checkAbort(session.signal)

    const sent = await sendRoleWrite(session, input.server, input.reason, createRequest(input, bits))
    const created = answeredRole(sent)
    if (created === null) {
      const readBack = await readBackCreated(session, input.server, input.name)
      throw uncertainRoleWrite(CREATE_UNCERTAIN_MESSAGE, readBack, causeOf(sent))
    }
    const steps = new StepErrors()
    await storeInSnapshot(session, steps, (stored) => ingestRole(session.mirror, stored, input.server, created.answer))
    return {
      server: input.server,
      role: { id: created.role.id, name: created.role.name, position: created.role.position },
      permissions: permissionNames(created.role.permissions),
      note: ROLE_CREATED_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}

/**
 * Edits a role after the checks against the stored roles and before any
 * request: the user may manage roles; the role is below their highest, not
 * managed, and not @everyone unless only permissions change; `grant` holds
 * neither `administrator` nor a permission the user lacks; and something
 * changes. The request carries only the changed fields, and the role's whole
 * new permission set. It is sent once and never retried; the outcomes are as a
 * creation's, with the read saying whether the role is there and as asked. The
 * role Discord returns goes into the snapshot, which a change to a role the
 * user holds expires instead.
 */
export async function editRole(input: RoleEditInput, ctx: ToolContext): Promise<RoleEditResult> {
  const bits = editBits(input)
  const session = await openChatSession(input, ctx)
  try {
    const snapshot = freshSnapshot(session, input.server)
    const role = findRole(snapshot, input.role)
    const standing = checkCanManageRoles(snapshot, serverOwned(session.mirror, input.server))
    if (role.id === snapshot.server) checkEveryoneEdit(input)
    else checkManageable(snapshot, role, standing)
    checkHandOut(standing, bits.grant, "Granting would give the role")
    const plan = planEdit(input, bits, role, readRoleRaw(session.mirror, input.server, role.id))
    checkAbort(session.signal)

    const steps = new StepErrors()
    const held = userHolds(snapshot, role)
    const sent = await sendRoleWrite(session, input.server, input.reason, editRequest(input.server, role.id, plan))
    const edited = answeredRole(sent, role.id)
    if (edited === null) {
      if (held) await expireSnapshot(session, steps, input.server)
      const readBack = await readBackEdited(session, input.server, role.id, plan.body)
      throw uncertainRoleWrite(EDIT_UNCERTAIN_MESSAGE, readBack, causeOf(sent))
    }
    await followInSnapshot(session, steps, input.server, held, (stored) =>
      ingestRole(session.mirror, stored, input.server, edited.answer),
    )
    return {
      server: input.server,
      role: { id: edited.role.id, name: edited.role.name, position: edited.role.position },
      changed: plan.changed,
      permissions: permissionNames(edited.role.permissions),
      note: held ? ROLE_EDITED_HELD_NOTE : ROLE_EDITED_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}

/**
 * Deletes a role after the checks against the stored roles and before any
 * request: the user may manage roles, and the role is below their highest, not
 * managed and not @everyone. Sent once and never retried; an outcome that may
 * have reached Discord is `uncertain` after one read of the server's roles.
 * The role leaves the snapshot, which a deletion of a role the user held
 * expires instead.
 */
export async function deleteRole(input: RoleDeleteInput, ctx: ToolContext): Promise<RoleDeleteResult> {
  const session = await openChatSession(input, ctx)
  try {
    const snapshot = freshSnapshot(session, input.server)
    const role = findRole(snapshot, input.role)
    checkManageable(snapshot, role, checkCanManageRoles(snapshot, serverOwned(session.mirror, input.server)))
    checkAbort(session.signal)

    const steps = new StepErrors()
    const held = userHolds(snapshot, role)
    const sent = await sendRoleWrite(session, input.server, input.reason, deleteRequest(input.server, role.id))
    if (sent.kind === "unclear") {
      if (held) await expireSnapshot(session, steps, input.server)
      const readBack = await readBackDeleted(session, input.server, role.id)
      throw uncertainRoleWrite(DELETE_UNCERTAIN_MESSAGE, readBack, sent.cause)
    }
    await followInSnapshot(session, steps, input.server, held, () =>
      ingestRoleRemoval(session.mirror, input.server, role.id),
    )
    return {
      server: input.server,
      role: { id: role.id, name: role.name },
      note: held ? ROLE_DELETED_HELD_NOTE : ROLE_DELETED_NOTE,
      ...(steps.any ? { errors: steps.errors } : {}),
    }
  } finally {
    session.close()
  }
}
