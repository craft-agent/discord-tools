import { ingestDmList, ingestMessages } from "../discord/ingest"
import { ALICE, CHANNEL, DM, ME, messageObject, userObject } from "../discord/objects.testing"
import { snowflakeAt } from "../discord/snowflake"
import { createChatFixture, type ChatFixture } from "../chats/read.testing"
import { seedChannels, seedHistory } from "../chats/read.messages.testing"
import { invoke } from "../tool"
import type { SendBody } from "./payload"
import { discordMessageSend } from "./send-tool"

/** The channel `CHANNEL`'s messages path, which a send posts to and a read-back reads. */
export const MESSAGES_PATH = `/channels/${CHANNEL}/messages`

/** One row of the send ledger, as a test reads it. */
export type LedgerRow = { nonce: string; status: string; message: string | null; code: string | null }

/** A label whose mirror holds a server text channel, a forum, a category, a DM and three current messages of the channel. */
export async function createSendFixture() {
  const f = await createChatFixture()
  seedChannels(f)
  f.seed((m) => ingestDmList(m, f.ingestContext(), [{ id: DM, type: 1, recipients: [userObject(ALICE)] }]))
  seedHistory(f, [1, 2, 3], { current: true })
  return {
    ...f,
    /** Runs `discord_message_send` as an entry point does: strict arguments, a result checked against its schema. */
    send: (args: unknown) => invoke(discordMessageSend, args, f.ctx),
    /** The send ledger, oldest first. */
    ledger: (): LedgerRow[] =>
      f.inspect(
        (m) =>
          m
            .prepare(
              "SELECT CAST(nonce AS TEXT) AS nonce, status, CAST(message AS TEXT) AS message, code FROM sends ORDER BY created, nonce",
            )
            .all() as LedgerRow[],
      ),
    /** The bodies of the sends the fake Discord received, as posted. */
    posted: (channel = CHANNEL): SendBody[] =>
      f.discord.api
        .filter((request) => request.method === "POST" && request.path === `/channels/${channel}/messages`)
        .map((request) => JSON.parse(request.body!) as SendBody),
    /** The requests that read a channel's newest messages. */
    readBacks: (channel = CHANNEL) =>
      f.discord.api.filter((request) => request.method === "GET" && request.path === `/channels/${channel}/messages`),
    /** Stores a message of the account, as a read-back would have. */
    seedOwn: (id: string, content: string) =>
      f.seed((m) =>
        ingestMessages(m, f.ingestContext(), [messageObject(id, CHANNEL, { author: { id: ME }, content })], {
          reactions: true,
        }),
      ),
  }
}

export type SendFixture = Awaited<ReturnType<typeof createSendFixture>>

/** A message of the account in `channel` as Discord answers a send, made at the fake clock's time plus `offset` ms. */
export function ownMessage(
  f: Pick<ChatFixture, "now">,
  channel: string,
  extra: Record<string, unknown> = {},
  offset = 0,
) {
  return messageObject(snowflakeAt(f.now() + offset), channel, { author: userObject(ME), ...extra })
}

/** Makes the fake Discord answer a send with the message it built, echoing the request's text and nonce. */
export function answerSends(f: SendFixture, channel = CHANNEL, extra: Record<string, unknown> = {}): void {
  f.discord.route("POST", `/channels/${channel}/messages`, (request) => {
    const body = JSON.parse(request.body!) as SendBody
    return {
      status: 200,
      json: ownMessage(f, channel, { content: body.content, nonce: body.nonce, flags: body.flags, ...extra }),
    }
  })
}
