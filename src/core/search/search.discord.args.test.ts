import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CATEGORY, FORUM } from "../chats/read.messages.testing"
import { failure } from "../chats/read.testing"
import { ToolError } from "../errors"
import { ALICE, CHANNEL, SERVER } from "../discord/objects.testing"
import { checkArgs, DISCORD_LIMIT_MAX } from "./args"
import { searchDiscord } from "./search.discord.testing"
import { createSearchFixture, seedWorld, type SearchFixture } from "./search.testing"
import { searchReadInput } from "./schemas"

const parse = (args: Record<string, unknown>) => searchReadInput.parse({ method: "discord", ...args })

/** The message `checkArgs` refuses method `discord`'s arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(parse(args))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

describe("the arguments of method discord", () => {
  test("any one of the filters it takes is enough, and the limit may be the maximum", () => {
    for (const filter of [
      { query: "a" },
      { author: ALICE },
      { mentions: ALICE },
      { has: ["link"] },
      { pinned: false },
    ]) {
      expect(() => checkArgs(parse({ ...filter, limit: DISCORD_LIMIT_MAX }))).not.toThrow()
    }
  })

  test("a search with only a scope, a bound or a limit is refused, without the mirror-only filters", () => {
    for (const scope of [{}, { channel: CHANNEL }, { server: SERVER }, { before: "2026-01-01" }, { limit: 5 }]) {
      const message = refusal(scope)
      expect(message).toContain("at least one of query, author, mentions, has, pinned;")
      expect(message).not.toContain("reacted")
    }
  })

  test.each([
    ["reacted", true],
    ["emoji", "👍"],
    ["threads", true],
  ])("%s is for method mirror and refused, naming it", (field, value) => {
    const message = refusal({ query: "a", channel: CHANNEL, [field]: value })
    expect(message).toContain(`${field} is not an argument of method discord`)
    expect(message).toContain("Only method mirror takes it")
  })

  test("a limit over 25 is refused", () => {
    expect(refusal({ query: "a", limit: DISCORD_LIMIT_MAX + 1 })).toContain(`at most ${DISCORD_LIMIT_MAX}`)
  })

  test("a channel and a server are not both given", () => {
    expect(refusal({ query: "a", channel: CHANNEL, server: SERVER })).toContain("not both")
  })
})

describe("the scope of method discord is checked against the mirror before any request", () => {
  let f: SearchFixture
  beforeEach(async () => {
    f = await createSearchFixture()
    seedWorld(f)
  })
  afterEach(async () => {
    await f.dispose()
  })

  test("a channel or a server the mirror does not know is not found", async () => {
    expect((await failure(searchDiscord(f, { channel: "1400000000000000999" }))).code).toBe("not_found")
    expect((await failure(searchDiscord(f, { server: "1400000000000000999" }))).code).toBe("not_found")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a category, and a forum with a pointer to its posts, are refused", async () => {
    const category = await failure(searchDiscord(f, { channel: CATEGORY }))
    expect(category.code).toBe("invalid_argument")
    expect(category.message).toContain("category")
    const forum = await failure(searchDiscord(f, { channel: FORUM }))
    expect(forum.code).toBe("invalid_argument")
    expect(forum.message).toContain("their own ids")
    expect(forum.message).toContain("method mirror with threads")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("both scopes, a mirror-only argument, a limit of 26 and a missing filter are refused", async () => {
    for (const args of [
      { channel: CHANNEL, server: SERVER },
      { reacted: true },
      { limit: DISCORD_LIMIT_MAX + 1 },
      { query: undefined, channel: CHANNEL },
      { before: "yesterday" },
    ]) {
      expect((await failure(searchDiscord(f, args))).code).toBe("invalid_argument")
    }
    expect(f.discord.requests).toHaveLength(0)
  })
})
