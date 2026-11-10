import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"
import { ArchiveUnreadable, CHUNK, checkAbort, openRegular } from "../archive/entry"
import { ArchiveRefused, type ArchiveReport } from "../archive/inspect"
import { shownName } from "../archive/names"
import { checkSentFile } from "../archive/sent"
import { ToolError } from "../errors"
import { errorCode } from "../files/errno"
import { cleanName } from "../files/names"
import { BYTES_PER_MB } from "../files/size"
import { openStaging } from "../files/staging"
import { isWithin, overlapsPrivate } from "../paths"
import type { ToolContext } from "../tool"

/** The most files one message carries. */
export const FILES_MAX = 10

/** The size cap per file, in megabytes, when the entry point names none: Discord's limit without Nitro. */
export const DEFAULT_SEND_MAX_MB = 10

/** Mode of a private copy: owner only. */
const COPY_MODE = 0o600

/** Opens a file to read without following a link at its path, and without blocking on a pipe put in its place. */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** Creates a new file, never writing through a link or over an existing one. */
const COPY_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/** A file about to be sent: the private copy that is checked, and what was found out about its source. */
export type OutgoingFile = {
  /** The path the caller gave, as given. */
  given: string
  /** Its real path. */
  source: string
  /** The name Discord gets: the real path's base name, cleaned as a received name is. */
  name: string
  /** The private copy, the only file read from now on. */
  copy: string
  size: number
  /** SHA-256 of the copy, hex. */
  sha256: string
  /** The archive's listing, when it is one. */
  archive?: ArchiveReport
}

/** The copies a call made, to be removed when it ends. */
export type Outgoing = {
  files: OutgoingFile[]
  /** Removes the copies; safe to call twice. */
  close(): Promise<void>
}

/** What deciding which files may be sent takes. */
export type LocateOptions = {
  /** Relative paths resolve against it. */
  cwd: string
  /** The folders files may be sent from, absolute. */
  dirs: readonly string[]
  /** The most bytes a file has. */
  maxBytes: number
  /** The directories the tools keep their own in, which no send directory may overlap. */
  privateDirs: Pick<ToolContext, "stateDir" | "ownDir">
}

/** Where a call may send files from and how large each may be: the call's settings, else its working directory and `DEFAULT_SEND_MAX_MB`. */
export function locateOptionsOf(ctx: ToolContext): LocateOptions {
  return {
    cwd: ctx.cwd,
    dirs: ctx.sendDirs ?? [ctx.cwd],
    maxBytes: (ctx.sendMaxMb ?? DEFAULT_SEND_MAX_MB) * BYTES_PER_MB,
    privateDirs: ctx,
  }
}

export type OutgoingOptions = LocateOptions & {
  /** The label's `outgoing` folder, which the copies go under. */
  staging: string
  now: () => number
  signal?: AbortSignal
}

/** A file found where the caller said, the name and size it has now, and the identity it had then. */
export type Located = {
  given: string
  shown: string
  source: string
  /** The name Discord would get: the real path's base name, cleaned as a received name is. */
  name: string
  size: number
  dev: bigint
  ino: bigint
}

const refuse = (file: string, message: string) => new ToolError("invalid_argument", message, { details: { file } })

/** Whether the file is not there (or something on the way is not a folder). */
const isMissing = (code: string) => code === "ENOENT" || code === "ENOTDIR"

/** The refusal for a file the system would not give: not there, or not readable for the reason it names. */
function unreadable(file: string, error: unknown) {
  const code = errorCode(error)
  return refuse(file, `${shownName(file)}: ${isMissing(code) ? "no such file" : `cannot be read (${code})`}`)
}

/** The real path of a send directory, refused when it is not a folder or overlaps the tools' own. */
async function resolveDir(dir: string, privateDirs: LocateOptions["privateDirs"]): Promise<string> {
  const real = await realpath(dir).catch(() => undefined)
  const info = real === undefined ? undefined : await stat(real).catch(() => undefined)
  if (real === undefined || !info?.isDirectory()) {
    throw new ToolError("invalid_argument", `send_dirs names ${shownName(dir)}, which is not a folder`, {
      details: { dir },
    })
  }
  if (await overlapsPrivate(real, privateDirs)) {
    throw new ToolError(
      "invalid_argument",
      `send_dirs names ${shownName(dir)}, which holds or sits in the tools' own state; nothing is sent from it`,
      { details: { dir } },
    )
  }
  return real
}

/** Finds `given` and refuses it unless it is a regular, non-empty file within the cap, inside a send directory, not listed before. */
async function locate(
  given: string,
  index: number,
  roots: readonly string[],
  options: LocateOptions,
  seen: Set<string>,
): Promise<Located> {
  const shown = shownName(given)
  const source = await realpath(resolve(options.cwd, given)).catch((error: unknown) => {
    throw unreadable(given, error)
  })
  let inside = false
  for (const root of roots) inside ||= await isWithin(source, root)
  if (!inside) throw refuse(given, `${shown} is outside the folders files may be sent from`)

  const info = await lstat(source, { bigint: true }).catch((error: unknown) => {
    throw unreadable(given, error)
  })
  if (!info.isFile()) throw refuse(given, `${shown} is not a regular file`)
  if (info.size === 0n) throw refuse(given, `${shown} is empty`)
  if (info.size > BigInt(options.maxBytes))
    throw refuse(given, `${shown} is larger than ${megabytes(options.maxBytes)} MB`)
  if (seen.has(source)) throw refuse(given, `${shown} is listed twice`)
  seen.add(source)
  return {
    given,
    shown,
    source,
    name: cleanName(basename(source), index + 1),
    size: Number(info.size),
    dev: info.dev,
    ino: info.ino,
  }
}

/** `bytes` as the megabytes a message names, without a needless fraction. */
const megabytes = (bytes: number) => Math.round((bytes / BYTES_PER_MB) * 100) / 100

/** The pieces of an open file, at most `CHUNK` bytes each; stops with the `AbortError` of a cancelled `signal`. */
async function* chunksOf(handle: FileHandle, signal: AbortSignal | undefined): AsyncGenerator<Buffer> {
  const stream = handle.createReadStream({ autoClose: false, highWaterMark: CHUNK })
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      checkAbort(signal)
      yield chunk
    }
  } finally {
    stream.destroy()
  }
}

/** Writes all of `chunk`, since a write may take less than it is given. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  for (let written = 0; written < chunk.length;) {
    written += (await handle.write(chunk, written, chunk.length - written)).bytesWritten
  }
}

/** Opens the source the way `locate` found it, or says it changed. */
async function openSource(file: Located): Promise<FileHandle> {
  const changed = () => refuse(file.given, `${file.shown} changed before it could be copied`)
  const handle = await open(file.source, READ_FLAGS).catch((error: unknown) => {
    const code = errorCode(error)
    throw code === "ELOOP" || isMissing(code) ? changed() : unreadable(file.given, error)
  })
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.dev !== file.dev || info.ino !== file.ino) throw changed()
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Copies the source once into `copy`, counting and hashing what is written; refuses a file that grew past `maxBytes`. */
async function copyOnce(file: Located, copy: string, options: OutgoingOptions) {
  checkAbort(options.signal)
  const input = await openSource(file)
  try {
    const output = await open(copy, COPY_FLAGS, COPY_MODE)
    try {
      const hash = createHash("sha256")
      let size = 0
      for await (const chunk of chunksOf(input, options.signal)) {
        size += chunk.length
        if (size > options.maxBytes) {
          throw refuse(file.given, `${file.shown} grew past ${megabytes(options.maxBytes)} MB`)
        }
        hash.update(chunk)
        await writeAll(output, chunk)
      }
      if (size === 0) throw refuse(file.given, `${file.shown} is empty`)
      return { size, sha256: hash.digest("hex") }
    } finally {
      await output.close()
    }
  } finally {
    await input.close()
  }
}

/**
 * Checks the copy by the names on its way and its bytes. The name Discord gets is checked too when
 * cleaning changed it, since it is the name the recipient sees.
 */
async function checkCopy(file: Located, name: string, copy: string, signal: AbortSignal | undefined) {
  const parts = file.source.split(sep).filter((part) => part !== "")
  const folders = parts.slice(0, -1)
  let archive: ArchiveReport | undefined
  try {
    for (const checked of new Set([parts[parts.length - 1], name])) {
      archive = (await checkSentFile(copy, [...folders, checked], { signal })).archive ?? archive
    }
  } catch (error) {
    if (error instanceof ArchiveRefused) {
      throw new ToolError("invalid_argument", `${file.shown} is not sent: ${error.message}`, {
        cause: error,
        details: { file: file.given },
      })
    }
    throw error
  }
  return archive
}

/**
 * Finds the files without touching them: each path is resolved against `cwd` and must be a regular,
 * non-empty file of at most `maxBytes` whose real path lies in one of `dirs`, listed once. Any
 * refusal is `invalid_argument` with `details.file` the path as given.
 */
export async function locateOutgoing(paths: readonly string[], options: LocateOptions): Promise<Located[]> {
  if (paths.length < 1 || paths.length > FILES_MAX) {
    throw new ToolError("invalid_argument", `A message carries 1 to ${FILES_MAX} files; got ${paths.length}.`)
  }
  const roots: string[] = []
  for (const dir of options.dirs) roots.push(await resolveDir(dir, options.privateDirs))
  const found: Located[] = []
  const seen = new Set<string>()
  for (const [index, given] of paths.entries()) found.push(await locate(given, index, roots, options, seen))
  return found
}

/**
 * Copies and checks every file, or throws before anything leaves: the files are found as
 * `locateOutgoing` does, then opened without following a link, copied once under `staging`, and
 * every check reads the copy. Any refusal is `invalid_argument` with `details.file` the path as
 * given, and leaves no copy behind; a cancelled `signal` rejects with its `AbortError`, also
 * leaving none. `close` removes the copies once the call is done with them.
 */
export async function prepareOutgoing(paths: readonly string[], options: OutgoingOptions): Promise<Outgoing> {
  const found = await locateOutgoing(paths, options)

  const staging = await openStaging(options.staging, options.now())
  try {
    const files: OutgoingFile[] = []
    for (const [index, file] of found.entries()) {
      const copy = staging.fileFor(index + 1)
      const { name } = file
      const { size, sha256 } = await copyOnce(file, copy, options)
      const archive = await checkCopy(file, name, copy, options.signal)
      files.push({ given: file.given, source: file.source, name, copy, size, sha256, ...(archive && { archive }) })
    }
    return { files, close: () => staging.remove() }
  } catch (error) {
    await staging.remove()
    throw error
  }
}

/** SHA-256 of a file read by path without following a link at it, for an approval prompt's pin. */
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  checkAbort(signal)
  const handle = await openRegular(path).catch((error: unknown) => {
    if (error instanceof ArchiveUnreadable || errorCode(error) === "ELOOP") {
      throw refuse(path, `${shownName(path)} is not a regular file`)
    }
    throw unreadable(path, error)
  })
  try {
    const hash = createHash("sha256")
    for await (const chunk of chunksOf(handle, signal)) hash.update(chunk)
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}
