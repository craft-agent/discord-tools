import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { ALICE, CHANNEL, SERVER } from "../discord/objects.testing"
import { checkArgs, DISCORD_LIMIT_MAX, MIRROR_LIMIT_MAX, SEARCH_LIMIT_DEFAULT } from "./args"
import { SEARCH_HAS, SEARCH_QUERY_MAX_LENGTH, searchReadInput } from "./schemas"

/** The message `checkArgs` refuses the arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(searchReadInput.parse({ method: "mirror", ...args }))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

describe("the arguments of method mirror", () => {
  test("any one filter is enough, and a scope or a bound alone is not", () => {
    for (const filter of [
      { query: "a" },
      { author: ALICE },
      { mentions: ALICE },
      { has: ["link"] },
      { pinned: false },
      { reacted: false },
      { emoji: "👍" },
    ]) {
      expect(() => checkArgs(searchReadInput.parse({ method: "mirror", ...filter }))).not.toThrow()
    }
    for (const scope of [{}, { channel: CHANNEL }, { server: SERVER }, { before: "2026-01-01" }, { limit: 5 }]) {
      const message = refusal(scope)
      expect(message).toContain("at least one of query, author, mentions, has, pinned, reacted, emoji")
      expect(message).toContain("discord_chat_read method messages")
    }
  })

  test.each(["channel", "server", "author", "mentions"])("%s must be an id, not a name", (field) => {
    expect(refusal({ query: "a", [field]: "general" })).toContain(`\`${field}\` must be an id`)
    expect(refusal({ query: "a", [field]: "0" })).toContain(`\`${field}\` must be an id`)
  })

  test("a channel and a server are not both given", () => {
    expect(refusal({ query: "a", channel: CHANNEL, server: SERVER })).toContain("not both")
  })

  test("threads needs a channel", () => {
    expect(refusal({ query: "a", threads: true })).toContain("`threads` needs `channel`")
    expect(refusal({ query: "a", server: SERVER, threads: true })).toContain("`threads` needs `channel`")
    expect(() => checkArgs(searchReadInput.parse({ method: "mirror", query: "a", threads: false }))).not.toThrow()
  })

  test("has lists each value once", () => {
    expect(refusal({ has: ["link", "link"] })).toContain("each of its values once")
    expect(() => checkArgs(searchReadInput.parse({ method: "mirror", has: [...SEARCH_HAS] }))).not.toThrow()
  })

  test("the bounds are ids, dates or timestamps, and in order", () => {
    expect(refusal({ query: "a", before: "yesterday" })).toContain("`before` must be")
    expect(refusal({ query: "a", before: "2026-01-01", after: "2026-02-01" })).toContain("earlier than")
  })

  test("limit is at most the mirror's maximum", () => {
    expect(SEARCH_LIMIT_DEFAULT).toBe(25)
    expect(DISCORD_LIMIT_MAX).toBe(25)
    expect(refusal({ query: "a", limit: MIRROR_LIMIT_MAX + 1 })).toContain(`at most ${MIRROR_LIMIT_MAX}`)
    expect(() =>
      checkArgs(searchReadInput.parse({ method: "mirror", query: "a", limit: MIRROR_LIMIT_MAX })),
    ).not.toThrow()
  })

  test("the schema bounds the query, the limit and the values", () => {
    for (const args of [
      { query: "" },
      { query: "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1) },
      { query: "a", limit: 0 },
      { query: "a", limit: 1.5 },
      { has: [] },
      { has: ["gif"] },
      { emoji: "" },
      { method: "web", query: "a" },
      { query: "a", color: "red" },
    ]) {
      expect(() => searchReadInput.strict().parse({ method: "mirror", ...args })).toThrow()
    }
  })
})
