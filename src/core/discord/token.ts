import { Buffer } from "node:buffer"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { lstat, readFile, rm } from "node:fs/promises"
import type { Stats } from "node:fs"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { readJsonFile, writePrivateFile } from "./private-file"

/** Where an account's token comes from: the environment variable, or the label's token file. */
export type TokenSource = "variable" | "file"

/** Bytes of randomness in the salt of a rejection record. */
const SALT_BYTES = 16

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
  if (env[variable]?.trim()) return "variable"
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
  const fromVariable = env[variable]?.trim()
  if (fromVariable) return { token: checkTokenShape(fromVariable, variable), source: "variable" }

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

/** Stores the token in the label's token file (mode 600, replaced atomically) and forgets any rejection. */
export async function writeTokenFile(paths: LabelPaths, token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) throw new ToolError("unauthenticated", "No token was given.")
  checkTokenShape(trimmed, "The token")
  await writePrivateFile(paths.token, trimmed)
  await clearRejected(paths)
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

function fingerprint(salt: string, token: string): string {
  return createHmac("sha256", salt).update(token).digest("hex")
}

/** Records that Discord rejected `token` at `at`; only a salted fingerprint of it is stored. */
export async function recordRejected(paths: LabelPaths, token: string, at: number): Promise<void> {
  const salt = randomBytes(SALT_BYTES).toString("hex")
  const record: AuthRecord = { rejectedAt: at, salt, fingerprint: fingerprint(salt, token) }
  await writePrivateFile(paths.auth, JSON.stringify(record))
}

/** When Discord rejected this very token, or `undefined`: another token counts as new, and a missing or malformed record as none. */
export async function rejectedAt(paths: LabelPaths, token: string): Promise<number | undefined> {
  const record = asAuthRecord(await readJsonFile(paths.auth))
  if (!record) return undefined
  const expected = Buffer.from(fingerprint(record.salt, token))
  const actual = Buffer.from(record.fingerprint)
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? record.rejectedAt : undefined
}

/** Forgets the rejection record. */
export async function clearRejected(paths: LabelPaths): Promise<void> {
  await rm(paths.auth, { force: true })
}
