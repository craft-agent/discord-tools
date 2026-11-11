import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { ToolError } from "../errors"
import { ALICE } from "../discord/objects.testing"
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
  })

  test("an argument of the other method is refused, naming the method that takes it", () => {
    expect(refusal({ method: "notes", query: "ali" })).toContain("Only method friends takes it")
    expect(refusal({ method: "friends", user: ALICE })).toContain("Only method notes takes it")
    expect(refusal({ method: "friends", user: ALICE })).toContain("it takes: account, method, query")
  })

  test("a user must be an id, not a name", () => {
    expect(refusal({ method: "notes", user: "alice" })).toContain("`user` must be an id")
    expect(refusal({ method: "notes", user: "0" })).toContain("`user` must be an id")
  })

  test("the methods are the ones the tool dispatches", () => {
    expect([...PEOPLE_METHODS]).toEqual(["friends", "notes"])
  })

  test("the schema bounds the method and the query and refuses unknown arguments", () => {
    for (const args of [
      { method: "profile" },
      {},
      { method: "friends", query: "" },
      { method: "friends", query: "x".repeat(101) },
      { method: "friends", color: "red" },
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
    expect(f.discord.api).toEqual([])
  })

  test("with an unknown method or argument is refused by the schema", async () => {
    await expect(f.people({ method: "profile" })).rejects.toThrow()
    await expect(f.people({ method: "friends", color: "red" })).rejects.toThrow()
  })
})
