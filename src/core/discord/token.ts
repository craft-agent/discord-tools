import { Buffer } from "node:buffer"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { lstat, readFile, rm } from "node:fs/promises"
import type { Stats } from "node:fs"
import { resolve } from "node:path"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { readJsonFile, writePrivateFile } from "./private-file"

/** Where an account's token comes from: the environment variable, or the label's token file. */
export type TokenSource = "variable" | "file"

/** Bytes of randomness in the salt of a rejection record. */
const SALT_BYTES = 16

/** Process-local rejection memory survives failed persistence and holds no raw tokens. */
const rejectionSalt = randomBytes(SALT_BYTES).toString("hex")
const rejections = new Map<string, Map<string, number>>()

/** Permission bits of group and others; a token file may have none of them. */
const GROUP_OTHER_BITS = 0o077

/** The name of the variable that holds a label's token. */
export function tokenVariable(envPrefix: string, label: string): string {
  return `${envPrefix}_TOKEN_${label.toUpperCase()}`
}

async function statTokenFile(paths: LabelPaths): Promise<Stats | undefined> {
  try {
    return await lstat(paths.token)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw error
  }
}

/** Where the token comes from, or `undefined` when there is none; never the token itself. */
export async function tokenSource(
  paths: LabelPaths,
  variable: string,
  env: Record<string, string | undefined>,
): Promise<TokenSource | undefined> {
  if (env[variable] !== undefined) return "variable"
  return (await statTokenFile(paths)) ? "file" : undefined
}

/** A user token is one word; whitespace inside it also rules out a `Bot ` token. */
function checkTokenShape(token: string, what: string): string {
  if (token === "" || /\s/.test(token)) {
    throw new ToolError("unauthenticated", `${what} does not look like a user token.`)
  }
  return token
}

/**
 * The label's token: the variable first, else the token file.
 *
 * The file must be a regular file, not a link, that only its owner can reach;
 * a token that is missing or not shaped like a user token throws
 * `unauthenticated`. No message contains the token.
 */
export async function readToken(
  paths: LabelPaths,
  variable: string,
  env: Record<string, string | undefined>,
): Promise<{ token: string; source: TokenSource }> {
  const fromVariable = env[variable]
  if (fromVariable !== undefined) return { token: checkTokenShape(fromVariable.trim(), variable), source: "variable" }

  const noToken = new ToolError(
    "unauthenticated",
    `No Discord token for account "${paths.label}": set ${variable}, or sign the account in.`,
  )
  const stat = await statTokenFile(paths)
  if (!stat) throw noToken
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ToolError("forbidden", `The token file ${paths.token} is a link or not a regular file; replace it.`)
  }
  if (stat.mode & GROUP_OTHER_BITS) {
    throw new ToolError(
      "forbidden",
      `The token file ${paths.token} can be read by other users; run chmod 600 ${JSON.stringify(paths.token)}.`,
    )
  }
  const token = (await readFile(paths.token, "utf8")).trim()
  if (!token) throw noToken
  return { token: checkTokenShape(token, `The token in ${paths.token}`), source: "file" }
}

/** Stores the token privately; only a different token clears the persisted rejection. */
export async function writeTokenFile(paths: LabelPaths, token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) throw new ToolError("unauthenticated", "No token was given.")
  checkTokenShape(trimmed, "The token")
  const rejected = await rejectedAt(paths, trimmed)
  await writePrivateFile(paths.token, trimmed)
  if (rejected === undefined) await clearRejected(paths)
}

type AuthRecord = { rejectedAt: number; salt: string; fingerprint: string }

function asAuthRecord(value: unknown): AuthRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { rejectedAt, salt, fingerprint } = value as Record<string, unknown>
  if (
    typeof rejectedAt !== "number" ||
    !Number.isFinite(rejectedAt) ||
    typeof salt !== "string" ||
    typeof fingerprint !== "string"
  ) {
    return undefined
  }
  return { rejectedAt, salt, fingerprint }
}

/** Account diagnostics must distinguish an absent record from damaged rejection evidence. */
async function readStrictAuthRecord(path: string): Promise<AuthRecord | undefined> {
  const invalid = new ToolError(
    "stale",
    "The credential rejection record is unreadable or malformed; inspect it and its permissions.",
  )
  try {
    const stat = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid
    const record = asAuthRecord(JSON.parse(await readFile(path, "utf8")))
    if (
      !record ||
      !/^[a-f0-9]{32}$/i.test(record.salt) ||
      !/^[a-f0-9]{64}$/i.test(record.fingerprint) ||
      !Number.isSafeInteger(record.rejectedAt) ||
      record.rejectedAt < 0 ||
      !Number.isFinite(new Date(record.rejectedAt).getTime())
    )
      throw invalid
    return record
  } catch {
    throw invalid
  }
}

function fingerprint(salt: string, token: string): string {
  return createHmac("sha256", salt).update(token).digest("hex")
}

function rememberRejected(paths: LabelPaths, token: string, at: number): void {
  const path = resolve(paths.auth)
  const tokens = rejections.get(path) ?? new Map<string, number>()
  tokens.set(fingerprint(rejectionSalt, token), at)
  rejections.set(path, tokens)
}

/** Records that Discord rejected `token` at `at`; only a salted fingerprint of it is stored. */
export async function recordRejected(paths: LabelPaths, token: string, at: number): Promise<void> {
  rememberRejected(paths, token, at)
  const salt = randomBytes(SALT_BYTES).toString("hex")
  const record: AuthRecord = { rejectedAt: at, salt, fingerprint: fingerprint(salt, token) }
  await writePrivateFile(paths.auth, JSON.stringify(record))
}

/** When Discord rejected this token. By default malformed records count as absent; strict diagnostics refuse them. */
export async function rejectedAt(
  paths: LabelPaths,
  token: string,
  options: { strict?: boolean } = {},
): Promise<number | undefined> {
  const path = resolve(paths.auth)
  const key = fingerprint(rejectionSalt, token)
  const remembered = rejections.get(path)?.get(key)
  if (remembered !== undefined) return remembered
  const record = options.strict ? await readStrictAuthRecord(paths.auth) : asAuthRecord(await readJsonFile(paths.auth))
  const observed = rejections.get(path)?.get(key)
  if (observed !== undefined) return observed
  if (!record) return undefined
  const expected = Buffer.from(fingerprint(record.salt, token))
  const actual = Buffer.from(options.strict ? record.fingerprint.toLowerCase() : record.fingerprint)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  rememberRejected(paths, token, record.rejectedAt)
  return record.rejectedAt
}

/** Removes the disk record; tokens already observed as rejected stay blocked in this process. */
export async function clearRejected(paths: LabelPaths): Promise<void> {
  await rm(paths.auth, { force: true })
}
