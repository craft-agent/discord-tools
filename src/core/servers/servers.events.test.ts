import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { SERVER } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { requestsOf, seedServers, storedUsersOf } from "../people/people.testing"
import { eventsPath } from "./events"
import type { EventItem } from "./schemas"
import { createServerFixture, type ServerFixture } from "./servers.testing"

const id = (n: number) => `14000000000000007${String(n).padStart(2, "0")}`
const CHANNEL = "1400000000000000200"
const CREATOR = "1400000000000000002"

let f: ServerFixture
beforeEach(async () => {
  f = await createServerFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const event = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  guild_id: SERVER,
  name: `Event ${n}`,
  scheduled_start_time: `2026-12-0${n}T18:00:00.000000+00:00`,
  scheduled_end_time: null,
  status: 1,
  entity_type: 2,
  channel_id: CHANNEL,
  entity_metadata: null,
  user_count: n,
  creator_id: CREATOR,
  ...extra,
})

const serve = (list: unknown) => f.discord.route("GET", eventsPath(SERVER), { status: 200, json: list })
const read = (args: Record<string, unknown> = {}) => f.servers({ method: "events", server: SERVER, ...args })

describe("the request", () => {
  test("is one GET of the scheduled events with the user counts, and nothing else", async () => {
    serve([event(1)])
    await read()
    expect(requestsOf(f)).toEqual([`GET ${eventsPath(SERVER)}`])
    expect(Object.fromEntries(f.discord.api[0]!.query)).toEqual({ with_user_count: "true" })
  })
})

describe("an event", () => {
  test("has what Discord says of it", async () => {
    serve([
      event(1, {
        description: "Bring a cup",
        scheduled_end_time: "2026-12-01T20:00:00.000000+00:00",
        entity_type: 3,
        channel_id: null,
        entity_metadata: { location: "The tea house" },
        status: 2,
        image: "abc123",
        creator_id: undefined,
        creator: { id: CREATOR },
      }),
    ])
    expect((await read()).events).toEqual([
      {
        id: id(1),
        name: "Event 1",
        description: "Bring a cup",
        status: "active",
        kind: "external",
        start: "2026-12-01T18:00:00.000Z",
        end: "2026-12-01T20:00:00.000Z",
        channel: null,
        location: "The tea house",
        interested: 1,
        creator: CREATOR,
        image: "abc123",
      },
    ])
  })

  test("has null for what Discord leaves out or says in a way not understood", async () => {
    serve([
      { id: id(1), name: "", description: "", status: 9, entity_type: 0, scheduled_start_time: "soon", user_count: -1 },
    ])
    expect((await read()).events).toEqual([
      {
        id: id(1),
        name: null,
        description: null,
        status: null,
        kind: null,
        start: null,
        end: null,
        channel: null,
        location: null,
        interested: null,
        creator: null,
        image: null,
      },
    ])
  })

  test.each<[number, EventItem["status"]]>([
    [1, "scheduled"],
    [2, "active"],
    [3, "completed"],
    [4, "canceled"],
  ])("with status %d is %s", async (status, name) => {
    serve([event(1, { status })])
    expect((await read()).events?.[0]?.status).toBe(name)
  })

  test.each<[number, EventItem["kind"]]>([
    [1, "stage"],
    [2, "voice"],
    [3, "external"],
  ])("with entity type %d is %s", async (entityType, kind) => {
    serve([event(1, { entity_type: entityType })])
    expect((await read()).events?.[0]?.kind).toBe(kind)
  })
})

describe("the list", () => {
  test("is ordered by start time, those without one last, then by id", async () => {
    serve([
      event(3),
      event(5, { scheduled_start_time: null }),
      event(4, { scheduled_start_time: "2026-12-01T18:00:00.000000+00:00" }),
      event(1, { scheduled_start_time: null }),
      event(2),
    ])
    const result = await read()
    expect(result.events?.map((item) => item.id)).toEqual([id(4), id(2), id(3), id(1), id(5)])
    expect(result).toMatchObject({ count: 5, total: 5, list_truncated: false })
  })

  test("lists 25 when no limit is given, and says when it cut", async () => {
    serve(Array.from({ length: 26 }, (_, n) => event(1, { id: String(1400000000000000800n + BigInt(n)) })))
    const result = await read()
    expect(result.events).toHaveLength(25)
    expect(result).toMatchObject({ count: 25, total: 26, list_truncated: true })
  })

  test("is cut at the limit, counting all of them", async () => {
    serve([event(1), event(2), event(3)])
    const result = await read({ limit: 2 })
    expect(result.events?.map((item) => item.id)).toEqual([id(1), id(2)])
    expect(result).toMatchObject({ count: 2, total: 3, list_truncated: true })
    expect(await read({ limit: 3 })).toMatchObject({ count: 3, total: 3, list_truncated: false })
  })

  test("of no events is empty", async () => {
    serve([])
    expect(await read()).toMatchObject({ events: [], count: 0, total: 0, list_truncated: false })
  })

  test("leaves out an entry without a valid id", async () => {
    serve([{ name: "no id" }, { id: "party", name: "bad id" }, event(1)])
    expect((await read()).events?.map((item) => item.id)).toEqual([id(1)])
  })

  test("is said to hold upcoming events only, in people's words, and nothing was stored", async () => {
    serve([event(1, { creator: { id: CREATOR, username: "alice" } })])
    const { note } = await read()
    expect(note).toContain("finished ones are not listed")
    expect(note).toContain("Nothing was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
    expect(storedUsersOf(f)).toEqual([])
  })
})

describe("Discord's answer", () => {
  test.each([
    ["an object", {}],
    ["null", null],
    ["a list with a non-object", [event(1), "junk"]],
  ])("%s is an upstream error", async (_name, malformed) => {
    serve(malformed)
    expect((await failure(read())).code).toBe("upstream_error")
  })

  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d is %s", async (status, code) => {
    f.discord.route("GET", eventsPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(read())).code).toBe(code)
  })
})
