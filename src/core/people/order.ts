/** What a list of people is ordered by. */
type Named = { id: string; name: string | null }

/** Orders ids as numbers. */
export function compareIds(a: string, b: string): number {
  const [x, y] = [BigInt(a), BigInt(b)]
  return x === y ? 0 : x < y ? -1 : 1
}

/** Orders people by name ignoring case, those without a name last, then by id as a number. */
export function byNameThenId(a: Named, b: Named): number {
  if (a.name !== b.name) {
    if (a.name === null) return 1
    if (b.name === null) return -1
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()]
    if (x !== y) return x < y ? -1 : 1
  }
  return compareIds(a.id, b.id)
}

/** Orders ISO 8601 UTC times as `toISOString` writes them, earliest first or, with `newestFirst`, latest first; a missing time last either way. */
export function compareTimes(a: string | null, b: string | null, newestFirst = false): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a < b ? -1 : 1) * (newestFirst ? -1 : 1)
}
