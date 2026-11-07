/** Milliseconds from the Unix epoch to Discord's epoch, 2015-01-01T00:00:00Z. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n

/** Bits of a snowflake that hold the worker, process and sequence below its timestamp. */
const TIMESTAMP_SHIFT = 22n

/** The largest id the mirror can store: SQLite's signed 64-bit INTEGER. A real snowflake stays below it until about 2084. */
const MAX_SNOWFLAKE = 2n ** 63n - 1n

/** One to twenty digits, the first not a zero. */
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,19}$/

/** Whether `value` is a snowflake id: a decimal string of 1 to 20 digits, without a leading zero, that fits SQLite's signed 64-bit INTEGER. */
export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value) && BigInt(value) <= MAX_SNOWFLAKE
}

/** The time a snowflake was made, in milliseconds since the Unix epoch. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> TIMESTAMP_SHIFT) + DISCORD_EPOCH_MS)
}

/** The smallest snowflake made at `ms` (milliseconds since the Unix epoch); `"0"` for a time before Discord's epoch. */
export function snowflakeAt(ms: number): string {
  const since = BigInt(Math.floor(ms)) - DISCORD_EPOCH_MS
  return since <= 0n ? "0" : String(since << TIMESTAMP_SHIFT)
}
