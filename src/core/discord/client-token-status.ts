import { ToolError } from "../errors"
import type { DiscordClientOptions } from "./client"
import { readToken, rejectedAt, tokenSource, type TokenSource } from "./token"

/** Local credential evidence only: available does not mean live authentication succeeded. */
export type ClientTokenStatus = {
  source: TokenSource | null
  status: "available" | "missing" | "invalid" | "unreadable" | "rejected"
  rejectedAt: number | null
}

/** Inspects credentials without initializing a client, sending requests or changing persisted state. */
export async function readClientTokenStatus(
  options: Pick<DiscordClientOptions, "paths" | "tokenVariable" | "env">,
): Promise<ClientTokenStatus> {
  let source: ClientTokenStatus["source"] = null
  try {
    source = (await tokenSource(options.paths, options.tokenVariable, options.env)) ?? null
    if (source === null) return { source, status: "missing", rejectedAt: null }
    const current = await readToken(options.paths, options.tokenVariable, options.env)
    const rejected = await rejectedAt(options.paths, current.token, { strict: true })
    return { source, status: rejected === undefined ? "available" : "rejected", rejectedAt: rejected ?? null }
  } catch (error) {
    const status = error instanceof ToolError && error.code === "unauthenticated" ? "invalid" : "unreadable"
    return { source, status, rejectedAt: null }
  }
}
