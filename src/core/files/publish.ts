import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, copyFile, link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { CHUNK } from "../archive/entry"
import { ToolError } from "../errors"
import { FOLDER_MODE } from "./download-dir"
import { numberedName } from "./names"

/** Mode of a saved file: readable by everyone, with no execute bit. */
const FILE_MODE = 0o644

/** How many files of one name a folder may hold before another is refused. */
export const COPIES_MAX = 99

/** The name a file has while it is being copied into the folder. */
export const PART_PREFIX = ".part-"

export const PART_RANDOM_BYTES = 8

/** A new file only: an existing one, or a link in its place, is never opened. */
export const NEW_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

/** An existing file is read through no link, and a special file never blocks the open. */
const EXISTING_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** The errors of a file system, or a pair of folders, that cannot make a hard link. */
export const NO_HARD_LINKS: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"])

/** Where a file was put: `already` when a file of the same name and the same bytes was there. */
export type Published = { status: "saved" | "already"; path: string }

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** The SHA-256 of what is in `handle`, read from its start. */
async function digest(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(CHUNK)
  for (let at = 0; ;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK, at)
    if (bytesRead === 0) return hash.digest("hex")
    hash.update(buffer.subarray(0, bytesRead))
    at += bytesRead
  }
}

/** The SHA-256 of a regular file, or undefined when `path` is anything else (a link, a folder, a special file) or cannot be read. */
async function digestOfRegular(path: string): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile()) return undefined
    const handle = await open(path, EXISTING_FILE_FLAGS)
    try {
      return (await handle.stat()).isFile() ? await digest(handle) : undefined
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Copies `from` to the new file `to`, which gets `FILE_MODE` whatever the umask. */
async function copyNew(from: string, to: string): Promise<void> {
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const copy = await open(to, NEW_FILE_FLAGS, FILE_MODE)
    try {
      await copy.chmod(FILE_MODE)
      const buffer = Buffer.allocUnsafe(CHUNK)
      for (;;) {
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

/**
 * The folder one message's files go to, `<download_dir>/<channel>-<message>`.
 * It is made when the first file is put in it, never before, and only a plain
 * folder is used: a link or a file of that name makes every save fail. Nothing
 * in it is ever replaced.
 */
export class MessageFolder {
  readonly #taken = new Set<string>()

  /** `linkFile` makes the hard link of a publish; it is `link` unless a test gives another. */
  constructor(
    readonly path: string,
    private readonly linkFile: typeof link = link,
  ) {}

  /**
   * Gives `part` its final name without replacing anything: by a hard link, or
   * by an exclusive copy where the file system has no hard links. A taken name
   * is `EEXIST` either way.
   */
  async #place(part: string, path: string): Promise<void> {
    try {
      await this.linkFile(part, path)
    } catch (error) {
      if (!NO_HARD_LINKS.has(String(errorCode(error)))) throw error
      await copyFile(part, path, constants.COPYFILE_EXCL)
      await chmod(path, FILE_MODE)
    }
  }

  /** Refuses a link or a file where the folder goes, as `invalid_argument`; a folder that is not there yet is fine. */
  async check(): Promise<void> {
    const found = await lstat(this.path).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    })
    if (found !== undefined && (!found.isDirectory() || found.isSymbolicLink())) {
      throw new ToolError(
        "invalid_argument",
        `${this.path} is not a plain folder (a link or a file); nothing was saved.`,
      )
    }
  }

  /** Makes the folder when it is not there, with `FOLDER_MODE` whatever the umask, and checks it is a plain one. */
  async #ensure(): Promise<void> {
    try {
      await mkdir(this.path, { mode: FOLDER_MODE })
      await chmod(this.path, FOLDER_MODE)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    await this.check()
  }

  /**
   * Puts a copy of the file `staged` in the folder under `name`, or the first
   * `name-2`, `name-3`, … that is free; a name taken earlier in this call counts
   * as taken whatever its case. The copy is made under a temporary name and
   * linked (else copied) to its final name, which never replaces anything: a file of the
   * same name with the same bytes is `already`, and any other is left alone.
   */
  async publish(staged: string, name: string): Promise<Published> {
    await this.#ensure()
    const part = join(this.path, `${PART_PREFIX}${randomBytes(PART_RANDOM_BYTES).toString("hex")}`)
    let partDigest: string | undefined
    try {
      await copyNew(staged, part)
      for (let n = 1; n <= COPIES_MAX; n++) {
        const candidate = n === 1 ? name : numberedName(name, n)
        if (this.#taken.has(candidate.toLowerCase())) continue
        const path = join(this.path, candidate)
        try {
          await this.#place(part, path)
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error
          const existing = await digestOfRegular(path)
          partDigest ??= await digestOfRegular(part)
          if (existing === undefined || existing !== partDigest) continue
          return { status: "already", path }
        }
        this.#taken.add(candidate.toLowerCase())
        return { status: "saved", path }
      }
      throw new Error(`there are already ${COPIES_MAX} files named like ${name}`)
    } finally {
      await unlink(part).catch(() => {})
    }
  }
}
