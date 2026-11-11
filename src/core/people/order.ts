/** What a list of people is ordered by. */
type Named = { id: string; name: string | null }

/** Orders people by name ignoring case, those without a name last, then by id as a number. */
export function byNameThenId(a: Named, b: Named): number {
  if (a.name !== b.name) {
    if (a.name === null) return 1
    if (b.name === null) return -1
    const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()]
    if (x !== y) return x < y ? -1 : 1
  }
  const [x, y] = [BigInt(a.id), BigInt(b.id)]
  return x === y ? 0 : x < y ? -1 : 1
}
