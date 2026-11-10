import { createHarness } from "../discord/client.testing"
import type { RecordedRequest } from "../discord/fake-discord.testing"
import { createOutgoingFixture } from "./outgoing.testing"
import type { OutgoingFile } from "./outgoing"
import { uploadFiles } from "./upload"

/** The chat the fixture uploads for, and the page the uploads claim to come from. */
export const DESTINATION = { id: "111", referer: "/channels/5/111" }

/** Where Discord's reservation of `DESTINATION` is asked. */
export const RESERVE_PATH = `/channels/${DESTINATION.id}/attachments`

/** The most files a message carries, which the fixture routes uploads for. */
const ROUTED_FILES = 10

/** The signed URL the fixture's reservation gives file `index`. */
export const storageUrlOf = (index: number) => `https://bucket-${index}.storage.googleapis.com/up/${index}/file.bin`

/** One slot of a reservation, shaped as Discord answers. */
export const slotOf = (index: number, extra: Record<string, unknown> = {}) => ({
  id: String(index),
  upload_url: storageUrlOf(index),
  upload_filename: `uploads/${index}/stored.bin`,
  ...extra,
})

/** A fake Discord with a warm client, a temporary send folder, and uploads that succeed unless a test says otherwise. */
export async function createUploadFixture() {
  const harness = await createHarness()
  await harness.warm()
  const outgoing = await createOutgoingFixture()
  harness.discord.route("POST", RESERVE_PATH, (request) => ({
    status: 200,
    json: {
      attachments: (JSON.parse(request.body!) as { files: unknown[] }).files.map((_, index) => slotOf(index)),
    },
  }))
  for (let index = 0; index < ROUTED_FILES; index++) {
    harness.discord.route("PUT", `/up/${index}/file.bin`, { status: 200 })
  }
  return {
    harness,
    outgoing,
    /** Writes one file per content (`f0.txt`, …) to the send folder and prepares them. */
    async prepare(contents: string[]): Promise<OutgoingFile[]> {
      const paths: string[] = []
      for (const [index, content] of contents.entries()) paths.push(await outgoing.write(`work/f${index}.txt`, content))
      return (await outgoing.prepare(paths)).files
    },
    /** `uploadFiles` for `DESTINATION` on the fixture's client and clock. */
    upload: (files: readonly OutgoingFile[], signal?: AbortSignal) =>
      uploadFiles(harness.client, DESTINATION, files, { now: harness.now, ...(signal ? { signal } : {}) }),
    /** The uploads the fake received, in order. */
    puts: (): RecordedRequest[] => harness.discord.requests.filter((request) => request.method === "PUT"),
    dispose: async () => {
      await outgoing.dispose()
      await harness.dispose()
    },
  }
}

export type UploadFixture = Awaited<ReturnType<typeof createUploadFixture>>
