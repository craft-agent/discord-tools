import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seedChannels, seedHistory, serveHistory } from "../chats/read.messages.testing"
import { createChatFixture } from "../chats/read.testing"
import { FakeMedia, type MediaAnswer } from "../discord/fake-media.testing"
import { ingestMessages } from "../discord/ingest"
import { CHANNEL, messageObject, msgId } from "../discord/objects.testing"
import { invoke, type ToolContext } from "../tool"
import { discordFileSave } from "./save-tool"

/** The message of `CHANNEL` that carries files. */
export const FILES_MESSAGE = msgId(10)

/** The id of a sticker the made-up message carries. */
export const STICKER = "1400000000000000800"

/** The messages path of the channel, which the fresh read asks for. */
export const MESSAGES_PATH = `/channels/${CHANNEL}/messages`

/** A signed link to a file on Discord's CDN, as an attachment carries it. */
export const attachmentUrl = (name: string) =>
  `https://cdn.discordapp.com/attachments/1400000000000000200/1400000000000000900/${name}?ex=1&is=2&hm=3`

/** An attachment as Discord sends it, whose link is `attachmentUrl(name)`. */
export function attachment(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: "1400000000000000900",
    filename: name,
    content_type: "image/png",
    size: 4,
    url: attachmentUrl(name),
    ...extra,
  }
}

/** The arguments of a save of the message `FILES_MESSAGE`. */
export const saveArgs = (extra: Record<string, unknown> = {}) => ({
  channel: CHANNEL,
  message: FILES_MESSAGE,
  ...extra,
})

/** The names in a folder, sorted; none when it is not there. */
export const namesIn = (dir: string) =>
  readdir(dir).then(
    (names) => names.sort(),
    () => [] as string[],
  )

/**
 * A label whose mirror holds a channel and its messages, a fake Discord that
 * answers the fresh read, a fake media host behind the one HTTP client, and a
 * download directory of its own (not yet made) with a limit of 1 MB.
 */
export async function createFilesFixture() {
  const f = await createChatFixture()
  seedChannels(f)
  seedHistory(f, [1, 2, 3], { current: true })
  const media = new FakeMedia(() => f.now())
  const bodies = new Map<string, MediaAnswer>()
  media.answer = (request) => bodies.get(request.url) ?? { status: 404 }
  const root = await mkdtemp(join(tmpdir(), "dsc-files-"))
  const others: string[] = []
  const downloadDir = join(root, "downloads")
  const runtime = f.ctx.runtime!
  const ctx: ToolContext = {
    ...f.ctx,
    downloadDir,
    downloadMaxMb: 1,
    runtime: { ...runtime, discord: { ...runtime.discord, download: media.transport } },
  }
  return {
    ...f,
    ctx,
    media,
    downloadDir,
    /** The folder the files of `FILES_MESSAGE` go to. */
    folder: join(downloadDir, `${CHANNEL}-${FILES_MESSAGE}`),
    /** What a call leaves in the label's staging folder. */
    staged: () => namesIn(f.paths.incoming),
    /** Makes the message carry `extra` (attachments, embeds, stickers): in the mirror, and as Discord shows it. */
    carry(extra: Record<string, unknown>) {
      const message = messageObject(FILES_MESSAGE, CHANNEL, extra)
      f.seed((m) => ingestMessages(m, f.ingestContext(), [message], { reactions: true }))
      serveHistory(f, [message])
      return message
    },
    /** Answers the request for `url` with these chunks, 200 and the headers (a type, for one). */
    host(url: string, chunks: (string | Uint8Array)[], headers: Record<string, string> = {}) {
      bodies.set(url, { chunks, headers })
    },
    /** Runs `discord_file_save` as an entry point does: strict arguments, a result checked against its schema. */
    save: (args: unknown, context: ToolContext = ctx) => invoke(discordFileSave, args, context),
    /** Another temporary directory, removed with the fixture. */
    async tempDir(prefix: string) {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      others.push(dir)
      return dir
    },
    dispose: async () => {
      await f.dispose()
      for (const dir of [root, ...others]) await rm(dir, { recursive: true, force: true })
    },
  }
}

export type FilesFixture = Awaited<ReturnType<typeof createFilesFixture>>
