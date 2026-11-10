import { ArchiveUnreadable, CHUNK, checkAbort, openRegular } from "./entry"
import { ArchiveRefused, SENT, inspectArchive, type ArchiveReport, type InspectOptions } from "./inspect"
import { HEAD_BYTES, RISKY_NAME, SCRIPT_NAME, formatOfName, kindOfHead } from "./kinds"
import { KeyScan, secretRefusal } from "./secrets"

/** What the check of a file about to be sent found out. */
export type SentCheck = {
  /** The inspection report, when the file is an archive that was read. */
  archive?: ArchiveReport
}

const NOT_REGULAR = "it is not a regular file"

/** A file that is not a regular file, or a link at the path, is refused; anything else is not this function's to name. */
function asNotRegular(error: unknown): unknown {
  if (error instanceof ArchiveUnreadable) return new ArchiveRefused(error.message, { cause: error })
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOOP")
    return new ArchiveRefused(NOT_REGULAR, { cause: error })
  return error
}

/** Reads the whole file once: returns its first `HEAD_BYTES`, refusing at the first private key block on the way. */
async function readHead(path: string, signal: AbortSignal | undefined): Promise<Buffer> {
  checkAbort(signal)
  const handle = await openRegular(path).catch((error: unknown) => {
    throw asNotRegular(error)
  })
  const file = handle.createReadStream({ autoClose: false, highWaterMark: CHUNK })
  const keys = new KeyScan()
  let head = Buffer.alloc(0)
  try {
    for await (const chunk of file as AsyncIterable<Buffer>) {
      checkAbort(signal)
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)])
      if (keys.push(chunk)) throw new ArchiveRefused("it holds a private key")
    }
    return head
  } finally {
    file.destroy()
    await handle.close()
  }
}

/**
 * Checks a file about to be sent, by the names on its way, its base name and its bytes, and an
 * archive by everything in it. `path` is the file to read, a regular file; `parts` are the
 * components of the real path it came from, folders first and its base name last. Rejects with
 * `ArchiveRefused`, whose one-line message says why the file must not go.
 */
export async function checkSentFile(
  path: string,
  parts: readonly string[],
  options: { limits?: InspectOptions["limits"]; signal?: AbortSignal } = {},
): Promise<SentCheck> {
  const secret = secretRefusal(parts)
  if (secret) throw new ArchiveRefused(secret)
  const name = parts[parts.length - 1]
  const readable = formatOfName(name) !== undefined
  if (!readable && RISKY_NAME.test(name) && !SCRIPT_NAME.test(name)) {
    throw new ArchiveRefused("it is a program, an installer or an archive this cannot check")
  }
  const kind = kindOfHead(await readHead(path, options.signal))
  if (kind === "program") throw new ArchiveRefused("its content is a program")
  if (kind === "archive" && !readable) throw new ArchiveRefused("its content is an archive, whatever the name says")
  if (!readable) return {}
  const archive = await inspectArchive(path, name, { ...SENT, limits: options.limits, signal: options.signal })
  return { archive }
}
