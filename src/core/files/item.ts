import { open, rm } from "node:fs/promises"
import { ArchiveRefused, RECEIVED, inspectArchive, type ArchiveReport } from "../archive/inspect"
import { HEAD_BYTES, formatOfName, refusalOfFile } from "../archive/kinds"
import type { DiscordClient } from "../discord/client"
import { isAbortError } from "../errors"
import type { SaveItem } from "./items"
import { cleanName } from "./names"
import { MessageFolder } from "./publish"
import type { SavedFile } from "./schemas"
import type { Staging } from "./staging"

/** How long a whole call may take, in milliseconds, downloads included. */
export const CALL_BUDGET_MS = 540_000

/** The most time one download gets. */
const DOWNLOAD_TIMEOUT_MS = 180_000

/** A download is not started with less time than this left in the call. */
const MIN_DOWNLOAD_MS = 5000

const OUT_OF_TIME = "out of time for this call"

const BYTES_PER_MB = 1024 * 1024

/** What saving one item needs, the same for every item of a call. */
export type SaveRun = {
  client: DiscordClient
  staging: Staging
  folder: MessageFolder
  /** The most megabytes a file may have. */
  maxMb: number
  /** When the call's time is up, by `now`. */
  deadline: number
  now(): number
  /** Marks the files saved as downloaded, where the system has such a mark. */
  mark(paths: string[]): Promise<void>
  signal?: AbortSignal
}

/** Why a file is not kept, or what was found out about it. */
type Checked = { refused: string } | { archive?: ArchiveReport }

/** The first bytes of a file. */
async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const head = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Looks at a downloaded file before it is kept: an archive by everything in
 * it, any other file by its name, its type and its first bytes.
 */
async function inspectStaged(
  path: string,
  name: string,
  type: string | undefined,
  signal?: AbortSignal,
): Promise<Checked> {
  if (formatOfName(name)) {
    try {
      return { archive: await inspectArchive(path, name, { ...RECEIVED, signal }) }
    } catch (error) {
      if (error instanceof ArchiveRefused) return { refused: `the archive: ${error.message}` }
      throw error
    }
  }
  const why = refusalOfFile({ name, type, head: await readHead(path) })
  return why === undefined ? {} : { refused: `it is ${why}` }
}

/** Why a file could not be put in the folder: the file system's error code, else what went wrong. */
function describeFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return `could not save the file: ${typeof code === "string" ? code : error instanceof Error ? error.message : String(error)}`
}

/**
 * Downloads one item, checks it and puts it in the message folder. A file that
 * is refused, too large, missing or that fails is reported as such and never
 * reaches the folder; only a cancellation is thrown. Whatever the outcome, the
 * staged copy is removed.
 */
export async function saveItem(item: SaveItem, position: number, run: SaveRun): Promise<SavedFile> {
  const name = cleanName(item.name, position)
  const outcome = (status: SavedFile["status"], why?: string, more: Partial<SavedFile> = {}): SavedFile => ({
    name,
    kind: item.kind,
    status,
    ...(why === undefined ? {} : { why }),
    ...(item.type === undefined ? {} : { type: item.type }),
    ...(item.size === undefined ? {} : { size: item.size }),
    ...(item.previewOf === undefined ? {} : { preview_of: item.previewOf }),
    ...more,
  })

  const named = refusalOfFile({ name, type: item.type })
  if (named !== undefined) return outcome("refused", `it is ${named}`)
  const left = run.deadline - run.now()
  if (left < MIN_DOWNLOAD_MS) return outcome("failed", OUT_OF_TIME)

  const staged = run.staging.fileFor(position)
  try {
    const got = await run.client.download(item.url, {
      to: staged,
      maxBytes: run.maxMb * BYTES_PER_MB,
      timeoutMs: Math.min(DOWNLOAD_TIMEOUT_MS, left),
      signal: run.signal,
      declaredSize: item.size,
    })
    if (got.status === "too_large") return outcome("too_large", `larger than the limit of ${run.maxMb} MB`)
    if (got.status !== "saved") return outcome(got.status, got.why)

    const checked = await inspectStaged(staged, name, got.type, run.signal)
    if ("refused" in checked) return outcome("refused", checked.refused)

    const kept = { ...(got.type === undefined ? {} : { type: got.type }), size: got.size }
    try {
      const published = await run.folder.publish(staged, name)
      if (published.status === "saved") await run.mark([published.path])
      return outcome(published.status, undefined, {
        path: published.path,
        ...kept,
        ...(checked.archive === undefined ? {} : { archive: checked.archive }),
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      return outcome("failed", describeFailure(error))
    }
  } finally {
    await rm(staged, { force: true })
  }
}
