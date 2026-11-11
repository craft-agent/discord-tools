import type { ToolSpec } from "./core"
import { discordAccountRead } from "./core/account/read"
import { discordMessageDelete } from "./core/actions/delete-tool"
import { discordMessageEdit } from "./core/actions/edit-tool"
import { discordPinAdd, discordPinRemove } from "./core/actions/pin-tool"
import { discordReactionAdd, discordReactionRemove } from "./core/actions/reaction-tool"
import { discordChatRead } from "./core/chats/read"
import { discordFileSave } from "./core/files/save-tool"
import { discordInboxRead } from "./core/inbox/read"
import { discordReadMark } from "./core/read-mark/read-mark-tool"
import { discordSavedAdd, discordSavedRemove } from "./core/saved/saved-tool"
import { discordSearchRead } from "./core/search/read"
import { discordFileSend } from "./core/sends/file-send-tool"
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
  discordSearchRead,
  discordInboxRead,
  discordSavedAdd,
  discordSavedRemove,
  discordReadMark,
  discordMessageSend,
  discordFileSend,
  discordFileSave,
  discordMessageEdit,
  discordMessageDelete,
  discordReactionAdd,
  discordReactionRemove,
  discordPinAdd,
  discordPinRemove,
]
