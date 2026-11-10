import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { isAbortError } from "../errors"
import { ArchiveUnreadable, CHUNK, checkAbort, openRegular } from "./entry"
import {
  ARCHIVE_LIMITS,
  ArchiveRefused,
  ODD_CHARACTERS,
  RECEIVED,
  UNREADABLE,
  inspectArchive,
  plainParts,
  shownName,
  tooBig,
  tooManyEntries,
} from "./inspect"
import { formatOfName, type ArchiveFormat } from "./kinds"
import { readEntries, type ArchiveEntry } from "./read"

const WORK_PREFIX = ".unpacking-"
const WORK_MODE = 0o700
const COPY_MODE = 0o600
const FOLDER_MODE = 0o755
/** No execute bit, ever: nothing unpacked is a program. */
const FILE_MODE = 0o644
const SUFFIX = ".unpacked"
const NAME_MAX = 200
const EXTENSION_MAX = 20
const COPIES_MAX = 99
const FOLDERS_MAX = 999
const ARCHIVE_EXTENSION = /\.(?:zip|tar\.gz|tgz|tar)$/i
const CLASH = "two entries have clashing names"

export type UnpackOptions = {
  /** Names or folders from the archive's listing; all files when absent. */
  only?: string[]
  /** Marks every file written (e.g. the quarantine); its failure never fails the unpack. */
  mark?: (paths: string[]) => Promise<void>
  limits?: Partial<typeof ARCHIVE_LIMITS>
  signal?: AbortSignal
}

export type UnpackResult = {
  /** The absolute path of the folder made. */
  folder: string
  /** Files written. */
  count: number
  /** Bytes written. */
  unpacked: number
  /** The first `listing` paths, relative to `folder`, as written on disk. */
  files: string[]
  /** Files not in `files`. */
  more: number
}

type Written = { folder: string; files: string[]; unpacked: number }

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** A refusal stays one, a cancellation stays one, damage and file system errors become one; a bug stays a bug. */
function asRefusal(error: unknown): unknown {
  if (error instanceof ArchiveRefused || isAbortError(error)) return error
  if (error instanceof ArchiveUnreadable || typeof errorCode(error) === "string") {
    return new ArchiveRefused("it cannot be unpacked", { cause: error })
  }
  return error
}

function splitExtension(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
}

/** The longest start of `text` that fits in `bytes` bytes of UTF-8, never splitting a code point. */
function cutBytes(text: string, bytes: number): string {
  let used = 0
  let cut = ""
  for (const character of text) {
    used += Buffer.byteLength(character)
    if (used > bytes) break
    cut += character
  }
  return cut
}

/** One path component as it is written to disk: odd characters replaced, never `.` or `..`, cut to `NAME_MAX` bytes. */
function diskName(part: string): string {
  const name = part.replace(ODD_CHARACTERS, "_").trim()
  if (name === "" || name === "." || name === "..") return "_"
  if (Buffer.byteLength(name) <= NAME_MAX) return name
  const [stem, extension] = splitExtension(name)
  const extensionBytes = Buffer.byteLength(extension)
  if (extensionBytes > 0 && extensionBytes <= EXTENSION_MAX)
    return cutBytes(stem, NAME_MAX - extensionBytes) + extension
  return cutBytes(name, NAME_MAX)
}

function numbered(name: string, n: number): string {
  const [stem, extension] = splitExtension(name)
  return `${stem}-${n}${extension}`
}

function checkWants(only: string[] | undefined): string[] | undefined {
  if (only === undefined) return undefined
  if (!Array.isArray(only) || only.length === 0 || !only.every((want) => typeof want === "string" && want !== "")) {
    throw new ArchiveRefused("entries must be a list of names from the archive's listing")
  }
  return only
}

/** Whether an entry is one of the wanted names or inside one of the wanted folders; the wants it matches are recorded. */
function isSelected(raw: string, wants: string[] | undefined, matched: Set<string>): boolean {
  if (!wants) return true
  const names = [raw, shownName(raw, Infinity)]
  let selected = false
  for (const want of wants) {
    const prefix = `${want.replace(/\/+$/, "")}/`
    if (names.some((name) => name === want || name.startsWith(prefix))) {
      matched.add(want)
      selected = true
    }
  }
  return selected
}

/** Copies the saved archive to `to` through one descriptor that follows no link, so the unpack reads a file nobody else can change. */
async function copySaved(from: string, to: string, signal: AbortSignal | undefined): Promise<void> {
  const source = await openRegular(from).catch((error: unknown) => {
    throw new ArchiveRefused(UNREADABLE, { cause: error })
  })
  try {
    const copy = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, COPY_MODE)
    try {
      const buffer = Buffer.allocUnsafe(CHUNK)
      for (;;) {
        checkAbort(signal)
        const { bytesRead } = await source.read(buffer, 0, CHUNK, null)
        if (bytesRead === 0) break
        await copy.writeFile(buffer.subarray(0, bytesRead))
      }
    } finally {
      await copy.close()
    }
  } finally {
    await source.close()
  }
}

/** Makes a folder with exactly `FOLDER_MODE`, whatever the umask. */
async function makeFolder(path: string): Promise<void> {
  await mkdir(path, { mode: FOLDER_MODE })
  await chmod(path, FOLDER_MODE)
}

/** Makes the missing folders below `root`, one at a time; a name already taken by a file is a clash. Returns the last folder's path. */
async function makeFolders(root: string, names: string[]): Promise<string> {
  let folder = root
  for (const name of names) {
    folder = join(folder, name)
    try {
      await makeFolder(folder)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
      if (!(await lstat(folder)).isDirectory()) throw new ArchiveRefused(CLASH)
    }
  }
  return folder
}

/** Creates a new file in `folder`, numbering the name while it is taken; returns the name used and the open file. */
async function createFile(folder: string, name: string): Promise<{ name: string; handle: FileHandle }> {
  for (let n = 1; n <= COPIES_MAX; n++) {
    const candidate = n === 1 ? name : numbered(name, n)
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    try {
      return { name: candidate, handle: await open(join(folder, candidate), flags, FILE_MODE) }
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOTDIR" || code === "EISDIR") throw new ArchiveRefused(CLASH)
      if (code !== "EEXIST") throw error
      if ((await lstat(join(folder, candidate))).isDirectory()) throw new ArchiveRefused(CLASH)
    }
  }
  throw new ArchiveRefused("too many entries share one name")
}

/** Writes the selected entries of the copy below `root`; returns the paths written, relative to `root`, and the bytes. */
async function writeEntries(
  copy: string,
  format: ArchiveFormat,
  root: string,
  wants: string[] | undefined,
  limits: typeof ARCHIVE_LIMITS,
  signal: AbortSignal | undefined,
): Promise<{ files: string[]; unpacked: number }> {
  const matched = new Set<string>()
  const files: string[] = []
  let entries = 0
  let unpacked = 0
  const write = async (entry: ArchiveEntry, folder: string, name: string): Promise<string> => {
    const file = await createFile(folder, name)
    try {
      await file.handle.chmod(FILE_MODE)
      for await (const chunk of entry.read()) {
        unpacked += chunk.length
        if (unpacked > limits.unpacked) throw tooBig(limits.unpacked)
        await file.handle.writeFile(chunk)
      }
    } finally {
      await file.handle.close()
    }
    return file.name
  }
  for await (const entry of readEntries(copy, format, signal)) {
    checkAbort(signal)
    entries += 1
    if (entries > limits.entries) throw tooManyEntries(limits.entries)
    const parts = plainParts(entry.name)
    if (!parts?.length || (entry.kind !== "file" && entry.kind !== "directory")) continue
    if (!isSelected(entry.name, wants, matched)) continue
    const names = parts.map(diskName)
    if (entry.kind === "directory") {
      await makeFolders(root, names)
      continue
    }
    const folder = await makeFolders(root, names.slice(0, -1))
    files.push([...names.slice(0, -1), await write(entry, folder, names[names.length - 1])].join("/"))
  }
  const absent = wants?.filter((want) => !matched.has(want))
  if (absent?.length) {
    throw new ArchiveRefused(`it has no entry named ${absent.map((want) => `'${shownName(want)}'`).join(", ")}`)
  }
  if (files.length === 0) throw new ArchiveRefused("nothing was selected to unpack")
  return { files, unpacked }
}

/** The first folder beside the archive that is not taken: `base.unpacked`, then `base-2.unpacked` and on. */
async function freeFolder(directory: string, base: string): Promise<string> {
  for (let n = 1; n <= FOLDERS_MAX; n++) {
    const candidate = join(directory, `${n === 1 ? base : `${base}-${n}`}${SUFFIX}`)
    try {
      await lstat(candidate)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return candidate
      throw error
    }
  }
  throw new ArchiveRefused("there are too many unpacked copies of it already")
}

/** Does the whole unpack inside `work`, a folder the caller removes afterwards. */
async function unpackInto(
  work: string,
  archive: string,
  name: string,
  format: ArchiveFormat,
  wants: string[] | undefined,
  options: UnpackOptions,
): Promise<Written> {
  const { signal } = options
  const limits = { ...ARCHIVE_LIMITS, ...options.limits }
  const copy = join(work, "archive")
  await copySaved(archive, copy, signal)
  await inspectArchive(copy, name, { ...RECEIVED, limits: options.limits, signal })
  const root = join(work, "out")
  await makeFolder(root)
  const { files, unpacked } = await writeEntries(copy, format, root, wants, limits, signal)
  const folder = await freeFolder(dirname(archive), diskName(name.replace(ARCHIVE_EXTENSION, "")))
  // A rename replaces an empty folder created in the instant after the check; nothing with content can be lost.
  await rename(root, folder)
  return { folder, files, unpacked }
}

/**
 * Unpacks an archive that was saved after its inspection into a new folder
 * beside it (`<name>.unpacked`, numbered when taken), by this code and never by
 * a program of the system. The archive is copied to a private folder and
 * inspected again there, and the entries are written from that copy, so
 * nothing can change between the check and the unpacking. Files are created
 * new, through no link, without an execute bit; a name already taken gets a
 * number. Any failure leaves nothing behind and rejects with `ArchiveRefused`
 * (an aborted `signal` with its `AbortError`). `name` decides the format.
 */
export async function unpackArchive(path: string, name: string, options: UnpackOptions = {}): Promise<UnpackResult> {
  const format = formatOfName(name)
  if (!format) throw new ArchiveRefused("it is not an archive this can unpack")
  const wants = checkWants(options.only)
  const archive = resolve(path)
  const work = join(dirname(archive), `${WORK_PREFIX}${randomBytes(6).toString("hex")}`)
  await mkdir(work, { mode: WORK_MODE }).catch((error: unknown) => {
    throw asRefusal(error)
  })
  let written: Written
  try {
    written = await unpackInto(work, archive, basename(name), format, wants, options)
  } catch (error) {
    throw asRefusal(error)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  const { folder, files, unpacked } = written
  try {
    await options.mark?.(files.map((file) => join(folder, file)))
  } catch {
    // Marking is best effort.
  }
  const listing = options.limits?.listing ?? ARCHIVE_LIMITS.listing
  return {
    folder,
    count: files.length,
    unpacked,
    files: files.slice(0, listing),
    more: Math.max(0, files.length - listing),
  }
}
