import type { ToolSpec } from "./core"
import { discordAccountRead } from "./core/account/read"
import { discordChatRead } from "./core/chats/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [discordAccountRead, discordChatRead]
