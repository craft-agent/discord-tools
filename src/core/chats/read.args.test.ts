import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { ensureLabelDir } from "../discord/labels"
import { openMirrorForWrite } from "../discord/mirror"
import { SERVER } from "../discord/objects.testing"
import { invoke } from "../tool"
import { DMS_LIMIT_MAX } from "./args"
import { discordChatRead } from "./read"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
})
afterEach(async () => {
  await f.dispose()
})

describe("arguments a method does not take", () => {
  test.each([
    [
      { method: "servers", server: SERVER },
      "server is not an argument of method servers; it takes: account, method, refresh",
    ],
    [{ method: "servers", query: "a" }, "query is not an argument of method servers"],
    [{ method: "channels", server: SERVER, refresh: true }, "refresh is not an argument of method channels"],
    [{ method: "channels", server: SERVER, limit: 5 }, "limit is not an argument of method channels"],
    [
      { method: "dms", refresh: true },
      "refresh is not an argument of method dms; it takes: account, method, query, limit, offset",
    ],
    [{ method: "dms", server: SERVER }, "server is not an argument of method dms"],
  ])("%j is refused", async (args, message) => {
    const error = await failure(f.read(args))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(f.discord.requests).toHaveLength(0)
  })

  test("an unknown argument or method is refused by the schema", async () => {
    expect((await failure(f.read({ method: "dms", color: "red" }))).code).toBe("invalid_argument")
    expect((await failure(f.read({ method: "search" }))).code).toBe("invalid_argument")
    expect((await failure(f.read({}))).code).toBe("invalid_argument")
  })
})

describe("required and checked arguments", () => {
  test("channels needs a server", async () => {
    const error = await failure(f.read({ method: "channels" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("needs `server`")
  })

  test.each(["general", "0", "01400000000000000100", "99999999999999999999", ""])(
    "%j is not a server id",
    async (server) => {
      const error = await failure(f.read({ method: "channels", server }))
      expect(error.code).toBe("invalid_argument")
      expect(f.discord.requests).toHaveLength(0)
    },
  )

  test("limit, offset and query stay within their bounds", async () => {
    const over = await failure(f.read({ method: "dms", limit: DMS_LIMIT_MAX + 1 }))
    expect(over.code).toBe("invalid_argument")
    expect(over.message).toContain(String(DMS_LIMIT_MAX))
    for (const args of [
      { limit: 0 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 100_001 },
      { query: "" },
      { query: "x".repeat(101) },
    ]) {
      expect((await failure(f.read({ method: "dms", ...args }))).code).toBe("invalid_argument")
    }
    expect(f.discord.requests).toHaveLength(0)
  })
})

describe("the account", () => {
  test("several labels without account are refused, naming them", async () => {
    await ensureLabelDir(f.stateDir, "second")
    const error = await failure(f.read({ method: "dms" }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("default, second")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a label without a mirror is not synced, and none is created", async () => {
    const paths = await ensureLabelDir(f.stateDir, "second")
    const error = await failure(f.read({ method: "dms", account: "second" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("Nothing has been synced")
    expect(existsSync(paths.mirror)).toBe(false)
    expect((await failure(f.read({ method: "dms", account: "third" }))).code).toBe("not_found")
  })

  test("a mirror that does not know who the user is says the sync has not run", async () => {
    const paths = await ensureLabelDir(f.stateDir, "second")
    openMirrorForWrite(paths.mirror).close()
    const error = await failure(f.read({ method: "dms", account: "second" }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain('sync of account "second" has not run')
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a call without a runtime or an absolute state directory is an internal error", async () => {
    const { runtime: _runtime, ...withoutRuntime } = f.ctx
    expect((await failure(invoke(discordChatRead, { method: "dms" }, withoutRuntime))).code).toBe("internal_error")
    const relative = { ...f.ctx, stateDir: "state" }
    expect((await failure(invoke(discordChatRead, { method: "dms" }, relative))).code).toBe("internal_error")
  })

  test("a cancelled call makes no request", async () => {
    const ctx = { ...f.ctx, signal: AbortSignal.abort() }
    await expect(invoke(discordChatRead, { method: "dms" }, ctx)).rejects.toMatchObject({ name: "AbortError" })
    expect(f.discord.requests).toHaveLength(0)
  })
})
