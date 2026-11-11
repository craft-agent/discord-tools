import { actionTargets } from "../actions/targets"
import { defineTool } from "../tool"
import { describeReadMark } from "./describe"
import { markRead } from "./mark"
import { readMarkInput, readMarkOutput } from "./schemas"

export const discordReadMark = defineTool({
  id: "discord_read_mark",
  title: "Mark a Discord chat read",
  intent: "About to mark a Discord chat read",
  description:
    "Marks one chat read on Discord up to a message: the one named in `message`, else the newest message the local mirror holds for the chat. Call it only when the person asks. It clears the chat's unread state and mention badge on every device the user has, the phone included, and no other tool marks anything read. Marking an older message than one already read does not make the newer messages unread again. The chat and the message are ids the local mirror knows (find them with discord_chat_read), never names, in an existing DM, group DM, server channel or thread. The request is attempted once and never retried. An `uncertain` error means it may have reached Discord and was not sent again; Discord offers no way to read the state back, and marking the same message again changes nothing further, so repeating the call is harmless, but tell the person first. The person approves every mark.",
  toolset: "inbox",
  class: "overwrite",
  input: readMarkInput,
  output: readMarkOutput,
  targets: actionTargets,
  describe: describeReadMark,
  execute: markRead,
})
