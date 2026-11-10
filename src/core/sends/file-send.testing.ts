import { readdir } from "node:fs/promises"
import { CHANNEL } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordFileSend } from "./file-send-tool"
import { FILES_MAX } from "./outgoing"
import { createOutgoingFixture } from "./outgoing.testing"
import type { SendBody } from "./payload"
import { createSendFixture, MESSAGES_PATH, ownMessage } from "./send.testing"
import { slotOf } from "./upload.testing"

/** Where Discord's reservation of `CHANNEL` is asked. */
export const ATTACH_PATH = `/channels/${CHANNEL}/attachments`

/** A send fixture, a temporary tree for the files (`files.work` is the working directory), and uploads that succeed unless a test says otherwise. */
export async function createFileSendFixture() {
  const f = await createSendFixture()
  const files = await createOutgoingFixture()
  const ctx: ToolContext = { ...f.ctx, cwd: files.work }
  f.discord.route("POST", ATTACH_PATH, (request) => ({
    status: 200,
    json: { attachments: (JSON.parse(request.body!) as { files: unknown[] }).files.map((_, index) => slotOf(index)) },
  }))
  for (let index = 0; index < FILES_MAX; index++) {
    f.discord.route("PUT", `/up/${index}/file.bin`, { status: 200 })
  }
  return {
    ...f,
    files,
    ctx,
    /** Runs `discord_file_send` as an entry point does, in the fixture's working directory unless `overrides` say otherwise. */
    sendFiles: (args: unknown, overrides: Partial<ToolContext> = {}) =>
      invoke(discordFileSend, args, { ...ctx, ...overrides }),
    /** The uploads the fake received, in order. */
    puts: () => f.discord.requests.filter((request) => request.method === "PUT"),
    /** The reservations the fake received. */
    reservations: () => f.discord.api.filter((request) => request.method === "POST" && request.path === ATTACH_PATH),
    /** Whether nothing was requested of Discord. */
    untouched: () => f.discord.api.length === 0 && f.discord.requests.every((request) => request.method !== "PUT"),
    /** What the label's staging folder holds. */
    staged: () =>
      readdir(f.paths.outgoing).then(
        (names) => names.sort(),
        () => [] as string[],
      ),
    dispose: async () => {
      await files.dispose()
      await f.dispose()
    },
  }
}

export type FileSendFixture = Awaited<ReturnType<typeof createFileSendFixture>>

/** Makes the fake Discord answer a message with the one it built, echoing the request's text, nonce, flags and attachments. */
export function answerFileSends(f: FileSendFixture): void {
  f.discord.route("POST", MESSAGES_PATH, (request) => {
    const body = JSON.parse(request.body!) as SendBody
    return {
      status: 200,
      json: ownMessage(f, CHANNEL, {
        content: body.content,
        nonce: body.nonce,
        flags: body.flags,
        attachments: (body.attachments ?? []).map(({ id, filename }) => ({ id, filename })),
      }),
    }
  })
}
