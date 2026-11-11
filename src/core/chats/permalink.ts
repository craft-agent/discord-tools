/** Where a message's page is: Discord's web client. */
const MESSAGE_URL = "https://discord.com/channels"

/** The place of a chat that belongs to no server (a DM or a group chat) in a message's page. */
const PRIVATE_PLACE = "@me"

/** The link to a message, as Discord's apps copy it; `server` is `null` for a chat that belongs to none. */
export function messagePermalink(server: string | null, chat: string, message: string): string {
  return `${MESSAGE_URL}/${server ?? PRIVATE_PLACE}/${chat}/${message}`
}
