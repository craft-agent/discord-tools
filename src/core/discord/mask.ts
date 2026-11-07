/** What a masked token is replaced with. */
const MASK = "<token>"

/** The shape of a user token: three dot-separated base64url parts. */
const TOKEN_SHAPE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g

/** The shape of an older two-factor token. */
const MFA_TOKEN_SHAPE = /mfa\.[A-Za-z0-9_-]{20,}/g

/**
 * Masks every token in `text`: the exact `token` when given, and anything
 * shaped like a Discord token, as the last line of defence for error text.
 */
export function maskTokens(text: string, token?: string): string {
  const exact = token ? text.replaceAll(token, MASK) : text
  return exact.replace(TOKEN_SHAPE, MASK).replace(MFA_TOKEN_SHAPE, MASK)
}
