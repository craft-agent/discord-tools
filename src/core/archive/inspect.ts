import { isAbortError } from "../errors"
import { ArchiveUnreadable, openRegular, type ArchiveEntry } from "./entry"
import {
  HEAD_BYTES,
  RISKY_NAME,
  SCRIPT_NAME,
  formatOfHead,
  formatOfName,
  kindOfHead,
  type ArchiveFormat,
} from "./kinds"
import { NAME_SHOWN, shownName } from "./names"
import { readEntries } from "./read"
import { KeyScan, secretRefusal } from "./secrets"

const MIB = 1024 * 1024
const FORMAT_HEAD_BYTES = 512
/** The refusal for a file that cannot be read as an archive. */
export const UNREADABLE = "it cannot be read as an archive"

/** The caps of an inspection. */
export const ARCHIVE_LIMITS = { entries: 500, unpacked: 500 * MIB, listing: 50, nameShown: NAME_SHOWN }

/** The archive, or something in it, may not be saved; the message is one line saying why. */
export class ArchiveRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ArchiveRefused"
  }
}

export type ArchiveReport = {
  format: ArchiveFormat
  /** Files with data. */
  entries: number
  /** Bytes read, not bytes declared. */
  unpacked: number
  /** The first `listing` cleaned names of files with data, in archive order. */
  names: string[]
  /** Files with data that are not in `names`. */
  more: number
}

export type InspectOptions = {
  /** Lets source scripts through, by name and by a shebang line; programs, installers and nested archives stay refused. */
  allowScripts: boolean
  /** Refuses an entry that holds a private key block. */
  scanKeys: boolean
  /** Refuses an entry named like a credential, key or database, or inside a folder that holds credentials. */
  denySecrets?: boolean
  limits?: Partial<typeof ARCHIVE_LIMITS>
  signal?: AbortSignal
}

/** The inspection of an archive somebody else sent: scripts are data until run, and nothing there can leak a key. */
export const RECEIVED: InspectOptions = { allowScripts: true, scanKeys: false }

/** The inspection of an archive about to be sent: scripts are code somebody shares, but nothing may leak a secret. */
export const SENT: InspectOptions = { allowScripts: true, scanKeys: true, denySecrets: true }

function refuse(shown: string, why: string): ArchiveRefused {
  return new ArchiveRefused(`${shown} ${why}`)
}

/** The refusal for more bytes than `limit`. */
export function tooBig(limit: number): ArchiveRefused {
  return new ArchiveRefused(`it would unpack to more than ${Math.round((limit / MIB) * 100) / 100} MiB`)
}

/** The refusal for more entries than `limit`. */
export function tooManyEntries(limit: number): ArchiveRefused {
  return new ArchiveRefused(`it has more than ${limit} entries`)
}

/** The parts of a plain relative path (none for `./`), or undefined when the name is anything else. */
export function plainParts(name: string): string[] | undefined {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    return undefined
  }
  const parts = name.split("/").filter((part) => part !== "" && part !== ".")
  return parts.includes("..") ? undefined : parts
}

/** What an inspection refuses is a refusal; a damaged or unreadable file is refused as one; a bug stays a bug. */
function asRefusal(error: unknown): unknown {
  if (error instanceof ArchiveRefused || isAbortError(error)) return error
  if (error instanceof ArchiveUnreadable || typeof (error as NodeJS.ErrnoException | undefined)?.code === "string") {
    return new ArchiveRefused(UNREADABLE, { cause: error })
  }
  return error
}

async function checkContent(path: string, format: ArchiveFormat): Promise<void> {
  const handle = await openRegular(path)
  try {
    const head = Buffer.alloc(FORMAT_HEAD_BYTES)
    const { bytesRead } = await handle.read(head, 0, FORMAT_HEAD_BYTES, 0)
    if (formatOfHead(head.subarray(0, bytesRead)) !== format) {
      throw new ArchiveRefused(`its content is not a ${format} archive, whatever the name says`)
    }
  } finally {
    await handle.close()
  }
}

/** Refuses an entry named like a secret or inside a folder that holds secrets; every part of a folder entry is a folder. */
function checkSecret(entry: ArchiveEntry, shown: string, parts: string[]): void {
  const reason = secretRefusal(entry.kind === "directory" ? [...parts, ""] : parts)
  if (reason) throw refuse(shown, reason.replace(/^it /, ""))
}

/** Refuses an entry by its type, its encryption and its name; folders are not judged by their names. */
function checkEntry(entry: ArchiveEntry, shown: string, parts: string[], options: InspectOptions): void {
  if (entry.kind === "link" || entry.kind === "special") throw refuse(shown, "is a link or a special file")
  if (entry.encrypted) throw refuse(shown, "is encrypted, so it cannot be checked")
  if (entry.kind === "directory") return
  const base = parts[parts.length - 1]
  const script = options.allowScripts && SCRIPT_NAME.test(base)
  if (formatOfName(base) || (RISKY_NAME.test(base) && !script)) throw refuse(shown, "is an archive or a program")
}

/** Reads a file entry to its end, counting what is really there; returns the bytes read. */
async function scan(
  entry: ArchiveEntry,
  shown: string,
  options: InspectOptions,
  limit: number,
  used: number,
): Promise<number> {
  if (used + entry.size > limit) throw tooBig(limit)
  let size = 0
  let head = Buffer.alloc(0)
  const keys = new KeyScan()
  for await (const chunk of entry.read()) {
    size += chunk.length
    if (used + size > limit) throw tooBig(limit)
    if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)])
    if (options.scanKeys && keys.push(chunk)) throw refuse(shown, "holds a private key")
  }
  const kind = kindOfHead(head)
  if (kind === "program") throw refuse(shown, "is a program")
  if (kind === "archive") throw refuse(shown, "is an archive inside the archive")
  if (kind === "script" && !options.allowScripts) throw refuse(shown, "is a script")
  return size
}

async function walk(
  path: string,
  format: ArchiveFormat,
  options: InspectOptions,
  limits: typeof ARCHIVE_LIMITS,
): Promise<ArchiveReport> {
  const names: string[] = []
  let entries = 0
  let files = 0
  let unpacked = 0
  for await (const entry of readEntries(path, format, options.signal)) {
    entries += 1
    if (entries > limits.entries) throw tooManyEntries(limits.entries)
    const shown = shownName(entry.name, limits.nameShown)
    const parts = plainParts(entry.name)
    if (!parts || (parts.length === 0 && entry.kind !== "directory"))
      throw refuse(shown, "is not a plain relative path")
    // `tar -cf x.tar .` starts with `./`, the folder the archive unpacks into.
    if (parts.length === 0) continue
    if (options.denySecrets) checkSecret(entry, shown, parts)
    checkEntry(entry, shown, parts, options)
    if (entry.kind !== "file") continue
    const size = await scan(entry, shown, options, limits.unpacked, unpacked)
    unpacked += size
    if (size > 0) {
      files += 1
      if (names.length < limits.listing) names.push(shown)
    }
  }
  if (files === 0) throw new ArchiveRefused("it contains no files")
  return { format, entries: files, unpacked, names, more: files - names.length }
}

/**
 * Looks inside an archive before it is saved, reading every entry in memory and
 * unpacking nothing. Resolves with a report when everything in it may be saved;
 * rejects with `ArchiveRefused` at the first entry that may not, or when the
 * archive cannot be read. Resolves with undefined when the name does not say
 * zip, tar or tar.gz: the caller's rules for single files decide then.
 */
export async function inspectArchive(
  path: string,
  name: string,
  options: InspectOptions,
): Promise<ArchiveReport | undefined> {
  const format = formatOfName(name)
  if (!format) return undefined
  const limits = { ...ARCHIVE_LIMITS, ...options.limits }
  try {
    await checkContent(path, format)
    return await walk(path, format, options, limits)
  } catch (error) {
    throw asRefusal(error)
  }
}
