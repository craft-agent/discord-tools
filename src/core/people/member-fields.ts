import { isoOrNull } from "../chats/format"
import { idTexts, textOrNull, timeOrNull, type JsonRecord } from "../discord/ingest-values"

/** What a server member object says about the person there: the nickname, when they joined and their role ids. */
export function memberFields(member: JsonRecord): { nick: string | null; joined: string | null; roles: string[] } {
  return {
    nick: textOrNull(member.nick),
    joined: isoOrNull(timeOrNull(member.joined_at)),
    roles: [...new Set(idTexts(member.roles))],
  }
}
