import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL } from "../discord/objects.testing"
import { discordReadMark } from "./read-mark-tool"
import { ackPath, createReadMarkFixture, NEWEST, type ReadMarkFixture } from "./read-mark.testing"

let f: ReadMarkFixture

beforeEach(async () => {
  f = await createReadMarkFixture()
})

afterEach(() => f.dispose())

const mark = () => failure(f.mark({ channel: CHANNEL }))
const SKIPPED = { code: "uncertain", details: { read_back: "skipped" } }

/** That the call sent the mark once, asked Discord for nothing else and stored nothing. */
function expectOneRequestAndNoStore(messages: number) {
  expect(f.discord.api).toHaveLength(1)
  expect(f.messageCount()).toBe(messages)
}

describe("a mark whose outcome is unknown", () => {
  test("a server error is uncertain with no read-back, never retried", async () => {
    const messages = f.messageCount()
    f.discord.route("POST", ackPath(NEWEST), { status: 500, json: { message: "oops" } })
    expect(await mark()).toMatchObject({ ...SKIPPED, message: expect.stringContaining("not sent again") })
    expectOneRequestAndNoStore(messages)
  })

  test("says that marking again is harmless once the user has been told", async () => {
    f.discord.route("POST", ackPath(NEWEST), { status: 502, json: {} })
    const error = await mark()
    expect(error.message).toContain("changes nothing further")
    expect(error.message).toContain("tell the user")
  })

  test("a failure after the request left is uncertain", async () => {
    const messages = f.messageCount()
    f.discord.failNext({ dispatched: true, message: "operation timed out" })
    expect(await mark()).toMatchObject(SKIPPED)
    expectOneRequestAndNoStore(messages)
  })

  test("an answer that is not JSON is uncertain, never a success", async () => {
    f.discord.route("POST", ackPath(NEWEST), { status: 200, text: "<html>" })
    expect(await mark()).toMatchObject(SKIPPED)
    expect(f.discord.api).toHaveLength(1)
  })

  test("a cancelled call is uncertain and reads nothing back", async () => {
    const controller = new AbortController()
    f.discord.route("POST", ackPath(NEWEST), () => {
      controller.abort()
      return { status: 500, json: {} }
    })
    const error = await discordReadMark
      .execute({ channel: CHANNEL }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).toMatchObject(SKIPPED)
    expect(f.discord.api).toHaveLength(1)
  })

  test("a call cancelled before it starts sends nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await discordReadMark
      .execute({ channel: CHANNEL }, { ...f.ctx, signal: controller.signal })
      .catch((e: unknown) => e)
    expect(error).not.toMatchObject({ code: "uncertain" })
    expect(f.discord.api).toHaveLength(0)
  })
})
