/** The URL as the transport must send it, when it is `https` with no userinfo and the default port. */
export function plainHttpsUrl(url: string): URL | undefined {
  if (!URL.canParse(url)) return undefined
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return undefined
  return parsed
}
