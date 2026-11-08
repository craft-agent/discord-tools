import type { ToolSpec } from "./core"
import { discordAccountRead } from "./core/account/read"
import { discordChatRead } from "./core/chats/read"
import { discordMessageSend } from "./core/sends/send-tool"
import { discordSyncAdd } from "./core/sync/add"
import { discordSyncRead } from "./core/sync/read"
import { discordSyncRemove } from "./core/sync/remove"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  discordAccountRead,
  discordSyncRead,
  discordSyncAdd,
  discordSyncRemove,
  discordChatRead,
  discordMessageSend,
]
