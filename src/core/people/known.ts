import { ToolError } from "../errors"
import type { ChatSession } from "../chats/session"
import type { Mirror } from "../discord/mirror"

/** The user the mirror knows; `not_found` otherwise, before any request is made. */
export function checkUser(session: ChatSession, user: string): void {
  if (!session.mirror.prepare("SELECT 1 FROM users WHERE id = ?").get(BigInt(user))) {
    throw new ToolError(
      "not_found",
      `This account has no user ${user} in its mirror: user ids come from discord_people_read method friends, a DM, a chat's messages or a mention.`,
    )
  }
}

/** Looks a server's name up by id in the mirror; `null` for a server it does not hold or that has no name. */
export function serverNameLookup(mirror: Mirror): (id: string) => string | null {
  const statement = mirror.prepare("SELECT name FROM servers WHERE id = ?")
  return (id) => (statement.get(BigInt(id)) as { name: string | null } | undefined)?.name ?? null
}
