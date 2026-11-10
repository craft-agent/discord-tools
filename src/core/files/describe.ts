import { describedAction, messageFacts } from "../actions/describe"
import { withMirror } from "../chats/describe"
import type { Mirror } from "../discord/mirror"
import { isRecord, textOrNull } from "../discord/ingest-values"
import type { CallDescription, CallFact, ToolContext } from "../tool"
import type { SaveInput } from "./schemas"

type AttachmentsRow = { attachments: string | null }

/** The `Unpack` fact, only when the call unpacks: the entries it names, else every archive. */
function unpackFacts({ unpack, entries }: SaveInput): CallFact[] {
  if (unpack !== true) return []
  return [{ label: "Unpack", value: entries === undefined ? { text: "Every archive" } : entries.join(", ") }]
}

/** The names of the attachments the mirror holds for a message, in order; none when it holds none or cannot be read. */
function attachmentNames(mirror: Mirror, { channel, message }: SaveInput): string[] {
  const row = mirror
    .prepare("SELECT attachments FROM messages WHERE id = ? AND channel = ?")
    .get(BigInt(message), BigInt(channel)) as AttachmentsRow | undefined
  if (!row?.attachments) return []
  try {
    const stored: unknown = JSON.parse(row.attachments)
    return Array.isArray(stored) ? stored.flatMap((item) => textOrNull(isRecord(item) ? item.name : null) ?? []) : []
  } catch {
    return []
  }
}

/**
 * What a save will do, from the mirror alone: the chat, the message's author
 * and start, whether archives are unpacked and which entries, and the names of
 * the attachments the mirror holds. Previews and stickers are not in the mirror
 * as files, so they are not listed. `not_found` when the mirror lacks the chat
 * or the message, which the save itself refuses.
 */
export async function describeSave(args: SaveInput, ctx: ToolContext): Promise<CallDescription> {
  return withMirror(args.account, ctx, (mirror) => {
    const { chat, message } = describedAction(mirror, args)
    const names = attachmentNames(mirror, args)
    return {
      headline: { text: "About to save files from {chat}", values: { chat: chat.name } },
      facts: [...chat.facts, ...messageFacts(message), ...unpackFacts(args)],
      ...(names.length === 0 ? {} : { text: { label: "Attachments", body: names.join("\n") } }),
    }
  })
}
