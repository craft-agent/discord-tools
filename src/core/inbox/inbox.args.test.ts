import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ToolError } from "../errors"
import { SERVER } from "../discord/objects.testing"
import { checkArgs, MENTIONS_LIMIT_DEFAULT, SAVED_LIMIT_DEFAULT, sinceId, WAITING_LIMIT_DEFAULT } from "./args"
import { createInboxFixture, type InboxFixture } from "./inbox.testing"
import { INBOX_METHODS, inboxReadInput } from "./schemas"

/** The message `checkArgs` refuses the arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(inboxReadInput.parse(args))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

const accepted = (args: Record<string, unknown>) => expect(() => checkArgs(inboxReadInput.parse(args))).not.toThrow()

describe("the arguments", () => {
  test("each method takes its own", () => {
    accepted({ method: "mentions", server: SERVER, before: "1400000000000000050", limit: 100 })
    accepted({ method: "waiting", server: SERVER, since: "2026-01-01", limit: 100 })
    accepted({ method: "mentions" })
    accepted({ method: "waiting", account: "default" })
  })

  test("an argument of the other method is refused, naming the method that takes it", () => {
    expect(refusal({ method: "mentions", since: "2026-01-01" })).toContain("Only method waiting takes it")
    expect(refusal({ method: "waiting", before: "1400000000000000050" })).toContain("Only method mentions takes it")
    expect(refusal({ method: "waiting", before: "1400000000000000050" })).toContain("it takes: account, method, server")
  })

  test.each(["mentions", "waiting"])("a server of method %s must be an id, not a name", (method) => {
    expect(refusal({ method, server: "general" })).toContain("`server` must be an id")
    expect(refusal({ method, server: "0" })).toContain("`server` must be an id")
  })

  test("before must be a message id, not a date", () => {
    expect(refusal({ method: "mentions", before: "yesterday" })).toContain("`before` must be an id")
    expect(refusal({ method: "mentions", before: "2026-01-01" })).toContain("`before` must be an id")
  })

  test("since is a message id, a date or a timestamp with a zone, and nothing else", () => {
    for (const since of ["yesterday", "2026-02-30", "2026-01-01T00:00:00", "12:00", "2026-01-01 00:00:00Z", "-5"]) {
      expect(refusal({ method: "waiting", since })).toContain("`since` must be a message id")
    }
    expect(refusal({ method: "waiting", since: "x".repeat(100) })).not.toContain("x".repeat(41))
    for (const since of ["1400000000000000050", "2026-01-01", "2026-01-01T00:00:00Z", "2026-01-01T09:00:00+09:00"]) {
      accepted({ method: "waiting", since })
    }
  })

  test("since names the id after which a message counts", () => {
    expect(sinceId("1400000000000000050")).toBe("1400000000000000050")
    expect(BigInt(sinceId("2026-01-01T00:00:00Z"))).toBe(BigInt(sinceId("2026-01-01")))
    expect(BigInt(sinceId("2026-01-01T00:00:00.001Z")) > BigInt(sinceId("2026-01-01T00:00:00Z"))).toBe(true)
  })

  test("limit has defaults and is at most 100 for mentions and waiting", () => {
    expect(MENTIONS_LIMIT_DEFAULT).toBe(25)
    expect(WAITING_LIMIT_DEFAULT).toBe(30)
    for (const method of ["mentions", "waiting"]) {
      expect(refusal({ method, limit: 101 })).toContain(`limit is at most 100 for method ${method}`)
      accepted({ method, limit: 100 })
      accepted({ method, limit: 1 })
    }
  })

  test("saved takes only a limit, of at most 200 and 50 by default", () => {
    expect(SAVED_LIMIT_DEFAULT).toBe(50)
    expect(refusal({ method: "saved", limit: 201 })).toContain("limit is at most 200 for method saved")
    accepted({ method: "saved", limit: 200 })
    accepted({ method: "saved", account: "default" })
    expect(refusal({ method: "saved", server: SERVER })).toContain("it takes: account, method, limit")
    expect(refusal({ method: "saved", before: "1400000000000000050" })).toContain("Only method mentions takes it")
  })

  test("the methods are the ones the tool dispatches", () => {
    expect([...INBOX_METHODS]).toEqual(["mentions", "waiting", "saved"])
  })

  test("the schema bounds the method and the limit and refuses unknown arguments", () => {
    for (const args of [
      { method: "unread" },
      {},
      { method: "waiting", limit: 0 },
      { method: "waiting", limit: 1.5 },
      { method: "mentions", color: "red" },
    ]) {
      expect(() => inboxReadInput.strict().parse(args)).toThrow()
    }
  })
})

describe("a call", () => {
  let f: InboxFixture
  beforeEach(async () => {
    f = await createInboxFixture()
  })
  afterEach(async () => {
    await f.dispose()
  })

  test("with a refused argument fails as invalid_argument before anything is opened or requested", async () => {
    expect((await failure(f.inbox({ method: "mentions", since: "2026-01-01" }))).code).toBe("invalid_argument")
    expect((await failure(f.inbox({ method: "waiting", limit: 101 }))).code).toBe("invalid_argument")
    expect(f.discord.requests).toEqual([])
  })

  test("with an unknown method or argument is refused by the schema", async () => {
    await expect(f.inbox({ method: "unread" })).rejects.toThrow()
    await expect(f.inbox({ method: "waiting", color: "red" })).rejects.toThrow()
  })
})
