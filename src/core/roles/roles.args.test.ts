import { describe, expect, test } from "bun:test"
import { SERVER } from "../discord/objects.testing"
import { ToolError } from "../errors"
import { checkArgs } from "./args"
import { MOD } from "./roles.testing"
import { roleReadInput } from "./schemas"

/** The message `checkArgs` refuses the arguments with; fails when it accepts them. */
function refusal(args: Record<string, unknown>): string {
  try {
    checkArgs(roleReadInput.parse(args))
  } catch (error) {
    if (error instanceof ToolError && error.code === "invalid_argument") return error.message
    throw error
  }
  throw new Error("expected the arguments to be refused")
}

const accepted = (args: Record<string, unknown>) => expect(() => checkArgs(roleReadInput.parse(args))).not.toThrow()

describe("the arguments", () => {
  test("each method takes its own", () => {
    accepted({ method: "list", server: SERVER })
    accepted({ method: "list", server: SERVER, account: "default" })
    accepted({ method: "role", server: SERVER, role: MOD })
    accepted({ method: "role", server: SERVER, role: SERVER })
    accepted({ method: "members", server: SERVER, role: MOD })
  })

  test("role is refused by list, naming the methods that take it", () => {
    const message = refusal({ method: "list", server: SERVER, role: MOD })
    expect(message).toContain("role is not an argument of method list")
    expect(message).toContain("Only methods role and members take it")
  })

  test("role is needed by role and members", () => {
    expect(refusal({ method: "role", server: SERVER })).toContain("needs `role`")
    expect(refusal({ method: "members", server: SERVER })).toContain("needs `role`")
  })

  test("a server and a role must be ids, not names", () => {
    expect(refusal({ method: "list", server: "tea house" })).toContain("`server` must be an id")
    expect(refusal({ method: "role", server: SERVER, role: "Moderator" })).toContain("`role` must be an id")
    expect(refusal({ method: "members", server: SERVER, role: "0" })).toContain("`role` must be an id")
  })

  test("members of @everyone, the role whose id is the server's, is refused", () => {
    expect(refusal({ method: "members", server: SERVER, role: SERVER })).toContain("@everyone")
  })

  test("an argument no method takes is refused as unknown", () => {
    expect(() => roleReadInput.strict().parse({ method: "list", server: SERVER, limit: 5 })).toThrow()
  })
})
