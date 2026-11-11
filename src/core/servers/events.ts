import { UNTRUSTED_NOTE, isoOrNull } from "../chats/format"
import { fieldOf, idText, intOrNull, textOrNull, timeOrNull, type JsonRecord } from "../discord/ingest-values"
import { countOrNull } from "../people/count"
import { compareIds, compareTimes } from "../people/order"
import { readLive } from "../people/request"
import { checkServer } from "../search/scope"
import { entriesOf } from "./entries"
import { EVENTS_LIMIT_DEFAULT, type EventItem, type ServerHandler } from "./schemas"

/** Where Discord lists a server's scheduled events. */
export const eventsPath = (server: string) => `/guilds/${server}/scheduled-events`

/** What the events are asked with: how many users are interested in each. */
const EVENTS_QUERY = { with_user_count: true }

/** The status of each of Discord's scheduled event status numbers. */
const EVENT_STATUSES: Readonly<Record<number, NonNullable<EventItem["status"]>>> = {
  1: "scheduled",
  2: "active",
  3: "completed",
  4: "canceled",
}

/** The kind of each of Discord's scheduled event entity types. */
const EVENT_KINDS: Readonly<Record<number, NonNullable<EventItem["kind"]>>> = {
  1: "stage",
  2: "voice",
  3: "external",
}

/** What the result of `events` tells about what Discord lists, how it is ordered and capped, whose words the texts are and what was stored. */
const EVENTS_NOTE =
  "The server's scheduled events, read from Discord once, by start time (any without a start last), capped by `limit` (`total` counts them before the cap, `list_truncated` says it cut). Discord lists scheduled and active events only: finished ones are not listed. `interested` is how many users said they are interested; give `event` to see who. Names, descriptions and locations are written by people. Nothing was stored in the local mirror."

/** The event's item; `null` for one without a valid id. */
function eventItem(entry: JsonRecord): EventItem | null {
  const id = idText(entry.id)
  if (id === null) return null
  return {
    id,
    name: textOrNull(entry.name),
    description: textOrNull(entry.description),
    status: EVENT_STATUSES[intOrNull(entry.status) ?? 0] ?? null,
    kind: EVENT_KINDS[intOrNull(entry.entity_type) ?? 0] ?? null,
    start: isoOrNull(timeOrNull(entry.scheduled_start_time)),
    end: isoOrNull(timeOrNull(entry.scheduled_end_time)),
    channel: idText(entry.channel_id),
    location: textOrNull(fieldOf(entry.entity_metadata, "location")),
    interested: countOrNull(entry.user_count),
    creator: idText(entry.creator_id) ?? idText(fieldOf(entry.creator, "id")),
    image: textOrNull(entry.image),
  }
}

/** Orders events by start time, those without one last, then by id as a number. */
function byStartThenId(a: EventItem, b: EventItem): number {
  return compareTimes(a.start, b.start) || compareIds(a.id, b.id)
}

/**
 * Method `events` without `event`: a server's upcoming and active scheduled
 * events with how many users are interested, in one request, by start time and
 * capped by `limit`. The server is checked against the mirror before it;
 * nothing is stored.
 */
export const readEvents: ServerHandler = async (session, args) => {
  const server = args.server
  checkServer(session, server)
  const limit = args.limit ?? EVENTS_LIMIT_DEFAULT
  const value = await readLive(session, "GET", eventsPath(server), { query: EVENTS_QUERY })
  const all = entriesOf(value)
    .flatMap((entry) => eventItem(entry) ?? [])
    .sort(byStartThenId)
  const events = all.slice(0, limit)
  return {
    note: `${EVENTS_NOTE} ${UNTRUSTED_NOTE}`,
    events,
    count: events.length,
    total: all.length,
    list_truncated: all.length > limit,
  }
}
