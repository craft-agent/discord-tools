import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ToolError } from "../errors"
import { ALICE, SERVER } from "../discord/objects.testing"
import { checkArgs } from "./args"
import { createPeopleFixture, type PeopleFixture } from "./people.testing"
import { PEOPLE_METHODS, peopleReadInput } from "./schemas"

/** The message `checkArgs` refuses the arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(peopleReadInput.parse(args))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

const accepted = (args: Record<string, unknown>) => expect(() => checkArgs(peopleReadInput.parse(args))).not.toThrow()

describe("the arguments", () => {
  test("each method takes its own", () => {
    accepted({ method: "friends" })
    accepted({ method: "friends", query: "ali", account: "default" })
    accepted({ method: "notes" })
    accepted({ method: "notes", user: ALICE })
    accepted({ method: "profile", user: ALICE })
    accepted({ method: "profile", user: ALICE, server: SERVER })
    accepted({ method: "member", user: ALICE, server: SERVER })
    accepted({ method: "members", server: SERVER, query: "ali" })
    accepted({ method: "members", server: SERVER, query: "ali", limit: 100 })
  })

  test("an argument of the other method is refused, naming the method that takes it", () => {
    expect(refusal({ method: "notes", query: "ali" })).toContain("Only methods friends and members take it")
    expect(refusal({ method: "friends", user: ALICE })).toContain("Only methods notes, profile and member take it")
    expect(refusal({ method: "friends", user: ALICE })).toContain("it takes: account, method, query")
    expect(refusal({ method: "notes", server: SERVER })).toContain("Only methods profile, member and members take it")
    expect(refusal({ method: "member", limit: 5 })).toContain("Only method members takes it")
    expect(refusal({ method: "members", user: ALICE, server: SERVER, query: "a" })).toContain(
      "user is not an argument of method members",
    )
    expect(refusal({ method: "profile", user: ALICE, query: "a" })).toContain("query is not an argument")
  })

  test("an argument a method needs and lacks is refused, naming it", () => {
    expect(refusal({ method: "profile" })).toContain("`user`")
    expect(refusal({ method: "member", server: SERVER })).toContain("`user`")
    expect(refusal({ method: "member", user: ALICE })).toContain("`server`")
    expect(refusal({ method: "members", query: "ali" })).toContain("`server`")
    expect(refusal({ method: "members", server: SERVER })).toContain("`query`")
  })

  test("a user and a server must be ids, not names", () => {
    expect(refusal({ method: "notes", user: "alice" })).toContain("`user` must be an id")
    expect(refusal({ method: "notes", user: "0" })).toContain("`user` must be an id")
    expect(refusal({ method: "profile", user: ALICE, server: "my server" })).toContain("`server` must be an id")
    expect(refusal({ method: "members", server: "0", query: "a" })).toContain("`server` must be an id")
  })

  test("the methods are the ones the tool dispatches", () => {
    expect([...PEOPLE_METHODS]).toEqual(["friends", "notes", "profile", "member", "members"])
  })

  test("the schema bounds the method, the query and the limit and refuses unknown arguments", () => {
    for (const args of [
      { method: "unknown" },
      {},
      { method: "friends", query: "" },
      { method: "friends", query: "x".repeat(101) },
      { method: "friends", color: "red" },
      { method: "members", limit: 0 },
      { method: "members", limit: 101 },
      { method: "members", limit: 1.5 },
    ]) {
      expect(() => peopleReadInput.strict().parse(args)).toThrow()
    }
    expect(() => peopleReadInput.strict().parse({ method: "friends", query: "x".repeat(100) })).not.toThrow()
  })
})

describe("a call", () => {
  let f: PeopleFixture
  beforeEach(async () => {
    f = await createPeopleFixture()
  })
  afterEach(async () => {
    await f.dispose()
  })

  test("with a refused argument fails as invalid_argument before anything is requested", async () => {
    expect((await failure(f.people({ method: "notes", query: "ali" }))).code).toBe("invalid_argument")
    expect((await failure(f.people({ method: "friends", user: ALICE }))).code).toBe("invalid_argument")
    expect((await failure(f.people({ method: "notes", user: "alice" }))).code).toBe("invalid_argument")
    expect((await failure(f.people({ method: "profile" }))).code).toBe("invalid_argument")
    expect((await failure(f.people({ method: "member", user: ALICE }))).code).toBe("invalid_argument")
    expect((await failure(f.people({ method: "members", server: SERVER }))).code).toBe("invalid_argument")
    expect(f.discord.api).toEqual([])
  })

  test("with an unknown method or argument is refused by the schema", async () => {
    await expect(f.people({ method: "unknown" })).rejects.toThrow()
    await expect(f.people({ method: "friends", color: "red" })).rejects.toThrow()
  })
})
