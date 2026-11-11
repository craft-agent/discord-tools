import { ToolError } from "../errors"
import type { ChatSession } from "../chats/session"

/** The user the mirror knows; `not_found` otherwise, before any request is made. */
export function checkUser(session: ChatSession, user: string): void {
  if (!session.mirror.prepare("SELECT 1 FROM users WHERE id = ?").get(BigInt(user))) {
    throw new ToolError(
      "not_found",
      `This account has no user ${user} in its mirror: user ids come from discord_people_read method friends, a DM, a chat's messages or a mention.`,
    )
  }
}
