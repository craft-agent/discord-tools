import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { checkAbort } from "../chats/session"
import type { DiscordClient } from "../discord/client"
import { isStorageUrl } from "../discord/upload"
import { isToolError, ToolError } from "../errors"
import type { OutgoingFile } from "./outgoing"

/** What a message's `attachments` names for a file that is up: the slot's id, the name Discord shows, and the name the storage holds it under. */
export type UploadedAttachment = { id: string; filename: string; uploaded_filename: string }

/** The time limit of one upload. */
export const UPLOAD_TIMEOUT_MS = 120_000

/** The time limit of all the uploads of a call, counted from the first. */
export const UPLOADS_TIMEOUT_MS = 600_000

/** Less than this left of `UPLOADS_TIMEOUT_MS` and the next upload is not started. */
const MIN_UPLOAD_LEFT_MS = 10_000

/** What every failure here ends with: the message is posted only once every file is up. */
const NOTHING_SENT = "no message was sent."

/** The answer to a reservation: the slots, whatever else it holds. */
const ReservationSchema = z.object({ attachments: z.array(z.unknown()) })

/** One slot of a reservation: Discord numbers it with the id the request gave, as a string or a number. */
const SlotSchema = z.object({
  id: z.union([z.string(), z.number()]),
  upload_url: z.string().refine(isStorageUrl),
  upload_filename: z.string().min(1),
})

type Slot = z.infer<typeof SlotSchema>

/** The id a file is reserved under, and the slot answers to. */
const slotId = (index: number) => String(index)

/** The slot for each file in `files`, in order, from Discord's answer; `upstream_error` when one has none usable. */
function slotsOf(answer: unknown, files: readonly OutgoingFile[]): Slot[] {
  const reservation = ReservationSchema.safeParse(answer)
  if (!reservation.success)
    throw new ToolError("upstream_error", `Discord did not reserve upload slots; ${NOTHING_SENT}`)
  const byId = new Map<string, Slot[]>()
  for (const entry of reservation.data.attachments) {
    const slot = SlotSchema.safeParse(entry)
    if (!slot.success) continue
    const id = String(slot.data.id)
    byId.set(id, [...(byId.get(id) ?? []), slot.data])
  }
  return files.map((file, index) => {
    const slots = byId.get(slotId(index))
    if (slots?.length !== 1) {
      throw new ToolError("upstream_error", `Discord returned no usable upload slot for ${file.name}; ${NOTHING_SENT}`)
    }
    return slots[0]!
  })
}

/** Asks Discord for one upload slot per file. A refusal propagates as it is; a write that may have left, or an unusable answer, is `upstream_error`. */
async function reserve(
  client: DiscordClient,
  destination: { id: string; referer: string },
  files: readonly OutgoingFile[],
  signal: AbortSignal | undefined,
): Promise<Slot[]> {
  let answer: unknown
  try {
    answer = await client.write("POST", `/channels/${destination.id}/attachments`, {
      body: { files: files.map((file, index) => ({ id: slotId(index), filename: file.name, file_size: file.size })) },
      referer: destination.referer,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    checkAbort(signal)
    if (isToolError(error) && error.code === "uncertain") {
      throw new ToolError("upstream_error", `Discord did not reserve upload slots; ${NOTHING_SENT}`, { cause: error })
    }
    throw error
  }
  return slotsOf(answer, files)
}

/** The copy's bytes, or `stale` when it is gone or no longer the size and hash that were checked. */
async function readCopy(file: OutgoingFile): Promise<Uint8Array> {
  const stale = (cause?: unknown) =>
    new ToolError("stale", `${file.name} changed while it was being sent; nothing was sent.`, {
      ...(cause === undefined ? {} : { cause }),
    })
  const bytes = await readFile(file.copy).catch((error: unknown) => {
    throw stale(error)
  })
  if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw stale()
  return bytes
}

/**
 * Reserves a slot for each file, then uploads each copy, in order, to its
 * signed URL; returns what the message body names, in file order. Any failure
 * throws, and nothing was sent: the message is posted only once every file is
 * up, and an upload is never retried. A refusal of the reservation propagates
 * with its own code; `uncertain`, an unusable answer, a slot that is not on
 * Discord's storage, a failed upload and uploads that outlast
 * `UPLOADS_TIMEOUT_MS` are `upstream_error`; a copy that is not what was
 * checked is `stale`. A cancelled `signal` rejects with its `AbortError`.
 */
export async function uploadFiles(
  client: DiscordClient,
  destination: { id: string; referer: string },
  files: readonly OutgoingFile[],
  options: { now: () => number; signal?: AbortSignal },
): Promise<UploadedAttachment[]> {
  const slots = await reserve(client, destination, files, options.signal)
  const started = options.now()
  const attached: UploadedAttachment[] = []
  for (const [index, file] of files.entries()) {
    checkAbort(options.signal)
    const slot = slots[index]!
    const bytes = await readCopy(file)
    const left = UPLOADS_TIMEOUT_MS - (options.now() - started)
    if (left < MIN_UPLOAD_LEFT_MS) {
      throw new ToolError("upstream_error", `The uploads took too long; ${NOTHING_SENT}`)
    }
    const result = await client.upload(slot.upload_url, bytes, {
      timeoutMs: Math.min(UPLOAD_TIMEOUT_MS, left),
      referer: destination.referer,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (result.status !== "uploaded") {
      throw new ToolError("upstream_error", `${file.name} could not be uploaded (${result.why}); ${NOTHING_SENT}`)
    }
    attached.push({ id: slotId(index), filename: file.name, uploaded_filename: slot.upload_filename })
  }
  return attached
}
