const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS

/** The fields of a local time that `localTimeIn` reads, as `formatToParts` names them. */
const CLOCK_FIELDS = ["year", "month", "day", "hour", "minute", "second"] as const

/** The sign, hours and minutes of an offset of `minutes` from UTC: `+09:00`, `-04:00`, `+05:45`, `+00:00`. */
function offsetText(minutes: number): string {
  const abs = Math.abs(minutes)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * A function that writes a time in milliseconds as local ISO 8601 with its
 * offset, to the second, in the IANA zone `zone` (`2026-03-02T08:30:00+09:00`;
 * UTC is `+00:00`, never `Z`). The offset is the zone's at that instant, so a
 * time on either side of a daylight saving change gets its own. Make one per
 * zone and reuse it: building the formatter is the costly part.
 */
export function localTimeIn(zone: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  return (ms) => {
    const second = Math.floor(ms / SECOND_MS) * SECOND_MS
    const parts = Object.fromEntries(format.formatToParts(second).map((part) => [part.type, part.value]))
    const [year, month, day, hour, minute, secondOfMinute] = CLOCK_FIELDS.map((field) => Number(parts[field]))
    const wallClock = Date.UTC(year!, month! - 1, day!, hour!, minute!, secondOfMinute!)
    const offset = Math.round((wallClock - second) / MINUTE_MS)
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetText(offset)}`
  }
}
