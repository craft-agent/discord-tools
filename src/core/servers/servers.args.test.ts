import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { SERVER } from "../discord/objects.testing"
import { ToolError } from "../errors"
import { seedServers } from "../people/people.testing"
import { checkArgs } from "./args"
import { createServerFixture, type ServerFixture } from "./servers.testing"
import { SERVER_METHODS, serverReadInput } from "./schemas"

const OTHER_SERVER = "1400000000000000101"

/** The message `checkArgs` refuses the arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(serverReadInput.parse(args))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

const accepted = (args: Record<string, unknown>) => expect(() => checkArgs(serverReadInput.parse(args))).not.toThrow()

describe("the arguments", () => {
  test("each method takes its own", () => {
    accepted({ method: "info", server: SERVER })
    accepted({ method: "info", server: SERVER, account: "default" })
    accepted({ method: "roles", server: SERVER })
    accepted({ method: "emojis", server: SERVER })
    accepted({ method: "emojis", server: SERVER, query: "wave", limit: 300 })
  })

  test("an argument of the other method is refused, naming the method that takes it", () => {
    expect(refusal({ method: "info", server: SERVER, query: "a" })).toContain("Only method emojis takes it")
    expect(refusal({ method: "roles", server: SERVER, limit: 5 })).toContain("Only method emojis takes it")
    expect(refusal({ method: "roles", server: SERVER, limit: 5 })).toContain("it takes: account, method, server.")
  })

  test("the server is required and must be an id, not a name", async () => {
    expect(() => serverReadInput.strict().parse({ method: "info" })).toThrow()
    expect(refusal({ method: "info", server: "tea house" })).toContain("`server` must be an id")
    expect(refusal({ method: "roles", server: "0" })).toContain("`server` must be an id")
  })

  test("the methods are the ones the tool dispatches", () => {
    expect([...SERVER_METHODS]).toEqual(["info", "roles", "emojis"])
  })

  test("the schema bounds the method, the query and the limit and refuses unknown arguments", () => {
    for (const args of [
      { server: SERVER },
      { method: "unknown", server: SERVER },
      { method: "emojis", server: SERVER, query: "" },
      { method: "emojis", server: SERVER, query: "x".repeat(101) },
      { method: "emojis", server: SERVER, limit: 0 },
      { method: "emojis", server: SERVER, limit: 301 },
      { method: "emojis", server: SERVER, limit: 1.5 },
      { method: "info", server: SERVER, color: "red" },
    ]) {
      expect(() => serverReadInput.strict().parse(args)).toThrow()
    }
    expect(() =>
      serverReadInput.strict().parse({ method: "emojis", server: SERVER, query: "x".repeat(100) }),
    ).not.toThrow()
  })
})

describe("a call", () => {
  let f: ServerFixture
  beforeEach(async () => {
    f = await createServerFixture()
    seedServers(f, [SERVER, "Tea house"])
  })
  afterEach(async () => {
    await f.dispose()
  })

  test("with a refused argument fails as invalid_argument before anything is requested", async () => {
    expect((await failure(f.servers({ method: "info", server: SERVER, query: "a" }))).code).toBe("invalid_argument")
    expect((await failure(f.servers({ method: "roles", server: "tea house" }))).code).toBe("invalid_argument")
    expect((await failure(f.servers({ method: "roles" }))).code).toBe("invalid_argument")
    expect(f.discord.api).toEqual([])
  })

  test.each(SERVER_METHODS)(
    "%s of a server the mirror does not know is not_found, and nothing is requested",
    async (method) => {
      const error = await failure(f.servers({ method, server: OTHER_SERVER }))
      expect(error.code).toBe("not_found")
      expect(error.message).toContain(OTHER_SERVER)
      expect(f.discord.api).toEqual([])
    },
  )
})
