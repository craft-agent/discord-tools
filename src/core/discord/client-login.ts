import { lstat } from "node:fs/promises"
import { ToolError } from "../errors"
import { readAccount, writeAccount } from "./account-meta"
import { createDiscordClient, type DiscordClientOptions } from "./client"
import { ensureLabelDir, type LabelPaths } from "./labels"
import { maskTokens } from "./mask"
import { isSnowflake } from "./snowflake"
import { existingBinding } from "./sync-identity"
import { acquireSyncLock, LOCK_HELD_REASON } from "./sync-lock"
import { clearRejected, writeTokenFile, type TokenSource } from "./token"

/** Includes build discovery and at most one API read retry. */
const LOGIN_REQUEST_BUDGET = 4

/**
 * Checks a legacy mirror without creating or migrating it. A mirror of an
 * older version is read too: a sync run migrates it only after signing in,
 * so refusing it here would leave a rejected token no way back.
 */
async function mirrorAccountId(paths: LabelPaths): Promise<string | undefined> {
  const stat = await lstat(paths.mirror).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (!stat) return undefined
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ToolError("stale", "The account's mirror is not a regular file; restore it before signing in.")
  }
  const id = existingBinding(paths.mirror)
  if (id !== undefined && !isSnowflake(id)) {
    throw new ToolError("stale", "The mirror's account identity is malformed; restore it before signing in.")
  }
  return id
}

/**
 * Signs a label in through the HTTP client boundary. A set variable wins,
 * even when empty; otherwise input supplies the candidate. Only a verified,
 * matching account can replace its private identity and (for input) token.
 */
export async function loginAccount(
  options: DiscordClientOptions & { readInput: () => Promise<string>; signal?: AbortSignal },
): Promise<{ id: string; name: string; source: TokenSource }> {
  let candidate: string | undefined
  try {
    options.signal?.throwIfAborted()
    await ensureLabelDir(options.stateDir, options.paths.label)
    const release = acquireSyncLock(options.paths.lock)
    if (!release) throw new ToolError("stale", LOCK_HELD_REASON)
    try {
      const account = await readAccount(options.paths)
      const mirrorId = await mirrorAccountId(options.paths)
      const source: TokenSource = options.env[options.tokenVariable] !== undefined ? "variable" : "file"
      if (source === "variable") {
        candidate = options.env[options.tokenVariable]!
      } else {
        try {
          candidate = await options.readInput()
        } catch {
          throw new ToolError("internal_error", "Could not read the login input; try signing in again.")
        }
      }
      candidate = candidate.trim()
      if (!candidate || /\s/.test(candidate)) {
        throw new ToolError("unauthenticated", "The login input does not look like a user token.")
      }
      options.signal?.throwIfAborted()
      const env = { ...options.env, [options.tokenVariable]: candidate }
      try {
        const client = createDiscordClient({
          ...options,
          env,
          budget: Math.min(options.budget ?? LOGIN_REQUEST_BUDGET, LOGIN_REQUEST_BUDGET),
        })
        const response = await client.read<unknown>("GET", "/users/@me", { signal: options.signal })
        const { id, username } =
          typeof response === "object" && response !== null ? (response as Record<string, unknown>) : {}
        if (
          !isSnowflake(id) ||
          maskTokens(id, candidate) !== id ||
          typeof username !== "string" ||
          !username.trim() ||
          maskTokens(username, candidate) !== username
        ) {
          throw new ToolError("upstream_error", "Discord did not return a valid account identity; nothing was saved.")
        }
        if ((account && account.id !== id) || (mirrorId !== undefined && mirrorId !== id)) {
          throw new ToolError(
            "invalid_argument",
            "This label belongs to a different account; sign in with another label.",
          )
        }
        options.signal?.throwIfAborted()
        await writeAccount(options.paths, { id, name: username, verifiedAt: (options.now ?? Date.now)() })
        if (source === "file") await writeTokenFile(options.paths, candidate)
        else await clearRejected(options.paths)
        return { id, name: username, source }
      } finally {
        delete env[options.tokenVariable]
      }
    } finally {
      release()
    }
  } catch (error) {
    if (options.signal?.aborted) throw new ToolError("internal_error", "Login was cancelled.")
    if (error instanceof ToolError) throw new ToolError(error.code, maskTokens(error.message, candidate))
    throw new ToolError("internal_error", "Login failed; try signing in again.")
  }
}
