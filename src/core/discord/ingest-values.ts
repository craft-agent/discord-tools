import { isSnowflake } from "./snowflake"

/** A JSON object of unknown contents. */
export type JsonRecord = Record<string, unknown>

/** Whether `value` is a JSON object: not null, not an array. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The field `key` of `value` when `value` is an object, else `undefined`. */
export function fieldOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** `value` when it is a non-empty string, else `null`. */
export function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

/** `value` when it is a safe integer, else `null`. */
export function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

/** `value` when it is a snowflake id, else `null`. */
export function idText(value: unknown): string | null {
  return isSnowflake(value) ? value : null
}

/** A snowflake id as the BigInt the mirror binds, or `null` when `value` is not one. */
export function idOrNull(value: unknown): bigint | null {
  return isSnowflake(value) ? BigInt(value) : null
}

/** 1 when `value` is `true`, else 0. */
export function flag(value: unknown): 0 | 1 {
  return value === true ? 1 : 0
}

/** The time of an ISO timestamp in milliseconds, or `null` when `value` is not one. */
export function timeOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

/** `value` when it is an array, else an empty one. */
export function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The ids in `value` that are snowflakes, as text. */
export function idTexts(value: unknown): string[] {
  return listOf(value).flatMap((item) => idText(item) ?? [])
}

/** `items` as JSON text, or `null` when there are none. */
export function jsonOrNull(items: readonly unknown[]): string | null {
  return items.length > 0 ? JSON.stringify(items) : null
}
