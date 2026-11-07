import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { writePrivateFile } from "./private-file"
import { isSnowflake } from "./snowflake"

/** The identity verified by login; `verifiedAt` is Unix time in milliseconds. */
export type AccountIdentity = { id: string; name: string; verifiedAt: number }

const INVALID_ACCOUNT = "The account identity record is unreadable or malformed; restore it before signing in again."

function isAccount(value: unknown): value is AccountIdentity {
  if (typeof value !== "object" || value === null) return false
  const { id, name, verifiedAt } = value as Record<string, unknown>
  return (
    isSnowflake(id) &&
    typeof name === "string" &&
    name.trim() !== "" &&
    typeof verifiedAt === "number" &&
    Number.isFinite(verifiedAt) &&
    verifiedAt >= 0
  )
}

/**
 * Reads the label's private `account.json`, independently of the mirror.
 * Only an absent file means no binding; unreadable or malformed state is
 * `stale`, so a damaged record never permits a different account to take over.
 * Sync and account tools may read this before a mirror exists. Sync remains
 * responsible for creating/migrating its mirror and importing the account id.
 */
export async function readAccount(paths: LabelPaths): Promise<AccountIdentity | undefined> {
  const path = join(paths.dir, "account.json")
  try {
    const stat = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(INVALID_ACCOUNT)
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isAccount(value)) throw new Error(INVALID_ACCOUNT)
    return { id: value.id, name: value.name, verifiedAt: value.verifiedAt }
  } catch {
    throw new ToolError("stale", INVALID_ACCOUNT)
  }
}

/**
 * Atomically stores a verified identity with mode 600, outside the mirror.
 * The caller must hold the label's sync lock and check existing account and
 * mirror bindings before calling. This function does not migrate the mirror.
 */
export async function writeAccount(paths: LabelPaths, account: AccountIdentity): Promise<void> {
  if (!isAccount(account)) throw new ToolError("invalid_argument", "A valid verified account identity is required.")
  const { id, name, verifiedAt } = account
  await writePrivateFile(join(paths.dir, "account.json"), JSON.stringify({ id, name, verifiedAt }))
}
