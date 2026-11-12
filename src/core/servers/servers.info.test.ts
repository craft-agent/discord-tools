import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { UNTRUSTED_NOTE } from "../chats/format"
import { failure } from "../chats/read.testing"
import { ALICE, CHANNEL, ME, OTHER_CHANNEL, SERVER } from "../discord/objects.testing"
import type { ErrorCode } from "../errors"
import { requestsOf, seedServers } from "../people/people.testing"
import { serverPath } from "./info"
import { createServerFixture, type ServerFixture, storedServersOf } from "./servers.testing"

let f: ServerFixture
beforeEach(async () => {
  f = await createServerFixture()
  seedServers(f, [SERVER, "Tea house"])
})
afterEach(async () => {
  await f.dispose()
})

const guild = (extra: Record<string, unknown> = {}) => ({
  id: SERVER,
  name: "Tea house",
  description: "Slow talk about tea",
  owner_id: ALICE,
  approximate_member_count: 1234,
  approximate_presence_count: 56,
  verification_level: 2,
  nsfw_level: 0,
  explicit_content_filter: 1,
  premium_tier: 1,
  premium_subscription_count: 4,
  features: ["COMMUNITY", "NEWS"],
  preferred_locale: "en-US",
  vanity_url_code: "tea",
  rules_channel_id: CHANNEL,
  system_channel_id: OTHER_CHANNEL,
  icon: "abc123",
  ...extra,
})
const serve = (body: unknown) => f.discord.route("GET", serverPath(SERVER), { status: 200, json: body })
const read = async () => (await f.servers({ method: "info", server: SERVER })).server

describe("the request", () => {
  test("is the server alone with its counts asked for", async () => {
    serve(guild())
    await f.servers({ method: "info", server: SERVER })
    expect(requestsOf(f)).toEqual([`GET ${serverPath(SERVER)}`])
    expect(Object.fromEntries(f.discord.api[0]!.query)).toEqual({ with_counts: "true" })
  })
})

describe("the result", () => {
  test("maps what the server says of itself", async () => {
    serve(guild())
    expect(await read()).toEqual({
      id: SERVER,
      name: "Tea house",
      description: "Slow talk about tea",
      owner: ALICE,
      you_own: false,
      created: "2025-07-30T06:20:10.742Z",
      members_approx: 1234,
      online_approx: 56,
      verification_level: 2,
      nsfw_level: 0,
      explicit_content_filter: 1,
      premium_tier: 1,
      premium_subscription_count: 4,
      features: ["COMMUNITY", "NEWS"],
      preferred_locale: "en-US",
      vanity_url_code: "tea",
      rules_channel: CHANNEL,
      system_channel: OTHER_CHANNEL,
      icon: "abc123",
    })
  })

  test("says the user owns a server whose owner is the account itself", async () => {
    serve(guild({ owner_id: ME }))
    expect(await read()).toMatchObject({ owner: ME, you_own: true })
  })

  test("has null for what Discord leaves out or empty, and no owner is not the user's", async () => {
    serve({ id: SERVER, description: "", vanity_url_code: null, features: "x", approximate_member_count: -1 })
    expect(await read()).toEqual({
      id: SERVER,
      name: null,
      description: null,
      owner: null,
      you_own: false,
      created: "2025-07-30T06:20:10.742Z",
      members_approx: null,
      online_approx: null,
      verification_level: null,
      nsfw_level: null,
      explicit_content_filter: null,
      premium_tier: null,
      premium_subscription_count: null,
      features: [],
      preferred_locale: null,
      vanity_url_code: null,
      rules_channel: null,
      system_channel: null,
      icon: null,
    })
  })

  test("keeps only the features that are text", async () => {
    serve(guild({ features: ["COMMUNITY", 5, null, "NEWS"] }))
    expect((await read())?.features).toEqual(["COMMUNITY", "NEWS"])
  })

  test("says the counts are estimates, the words are people's and nothing was stored", async () => {
    serve(guild())
    const { note } = await f.servers({ method: "info", server: SERVER })
    expect(note).toContain("estimates")
    expect(note).toContain("Nothing was stored")
    expect(note).toContain(UNTRUSTED_NOTE)
  })

  test("writes nothing to the mirror, whose server row stays what the sync wrote", async () => {
    const before = storedServersOf(f)
    serve(guild({ name: "Renamed" }))
    expect((await read())?.name).toBe("Renamed")
    expect(storedServersOf(f)).toEqual(before)
  })
})

describe("Discord's answer", () => {
  test.each<[number, ErrorCode]>([
    [403, "forbidden"],
    [404, "not_found"],
    [500, "upstream_error"],
  ])("%d is %s, as it is", async (status, code) => {
    f.discord.route("GET", serverPath(SERVER), { status, json: { code: 0, message: "refused" } })
    expect((await failure(f.servers({ method: "info", server: SERVER }))).code).toBe(code)
  })

  test.each([
    ["an array", []],
    ["null", null],
    ["text", "x"],
  ])("%s is an upstream error", async (_name, body) => {
    serve(body)
    expect((await failure(f.servers({ method: "info", server: SERVER }))).code).toBe("upstream_error")
  })
})
