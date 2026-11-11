import { intOrNull } from "../discord/ingest-values"

/** `value` when it is a count: a safe integer, not negative; else `null`. */
export function countOrNull(value: unknown): number | null {
  const count = intOrNull(value)
  return count !== null && count >= 0 ? count : null
}
