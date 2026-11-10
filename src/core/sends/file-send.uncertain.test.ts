import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../chats/read.testing"
import { CHANNEL } from "../discord/objects.testing"
import { createFileSendFixture, type FileSendFixture } from "./file-send.testing"
import { MESSAGES_PATH, ownMessage } from "./send.testing"

let f: FileSendFixture

beforeEach(async () => {
  f = await createFileSendFixture()
  await f.files.write("work/a.txt", "first")
  await f.files.write("work/b.txt", "second")
})

afterEach(() => f.dispose())

/** `count` attachments as Discord lists them. */
const attachmentsOf = (count: number, name = "stored.txt") =>
  Array.from({ length: count }, (_, index) => ({ id: String(index + 1), filename: name }))

/** A message of the account that looks like the send, or differs by `extra`, made `offset` ms after the clock. */
const own = (extra: Record<string, unknown>, offset = 500) => ownMessage(f, CHANNEL, extra, offset)

const send = (args: Record<string, unknown> = {}) =>
  failure(f.sendFiles({ channel: CHANNEL, files: ["a.txt", "b.txt"], text: "hi", ...args }))

describe("a file send whose outcome is unknown", () => {
  test("a server error is uncertain, never retried, and the read-back matches by content and attachment count", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 500, json: { message: "oops" } })
    const match = own({ content: "hi", attachments: attachmentsOf(2, "renamed.txt") }, 500)
    f.discord.route("GET", MESSAGES_PATH, {
      status: 200,
      json: [
        own({ content: "hi", attachments: attachmentsOf(1) }, 700),
        own({ content: "hi", attachments: attachmentsOf(3) }, 650),
        own({ content: "hi" }, 600),
        own({ content: "other", attachments: attachmentsOf(2) }, 550),
        match,
      ],
    })
    const error = await send()
    expect(error).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("not sent again"),
      details: { nonce: f.posted()[0]!.nonce, matches: [match.id], read_back: "done" },
    })
    expect(f.posted()).toHaveLength(1)
    expect(f.puts()).toHaveLength(2)
    expect(f.reservations()).toHaveLength(1)
    expect(f.readBacks()).toHaveLength(1)
    expect(f.ledger()).toEqual([{ nonce: f.posted()[0]!.nonce, status: "uncertain", message: null, code: "uncertain" }])
    expect(await f.staged()).toEqual([])
  })

  test("files sent alone are matched by empty content", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 502, json: {} })
    const match = own({ content: "", attachments: attachmentsOf(2) })
    f.discord.route("GET", MESSAGES_PATH, {
      status: 200,
      json: [own({ content: "hi", attachments: attachmentsOf(2) }), match],
    })
    expect(await failure(f.sendFiles({ channel: CHANNEL, files: ["a.txt", "b.txt"] }))).toMatchObject({
      code: "uncertain",
      details: { matches: [match.id] },
    })
  })

  test("a request dropped after it left is uncertain", async () => {
    f.discord.route("PUT", "/up/1/file.bin", () => {
      f.discord.failNext({ dispatched: true, message: "operation timed out" })
      return { status: 200 }
    })
    f.discord.route("GET", MESSAGES_PATH, { status: 200, json: [] })
    expect(await send()).toMatchObject({ code: "uncertain", details: { matches: [], read_back: "done" } })
    expect(f.posted()).toHaveLength(1)
    expect(f.ledger()).toMatchObject([{ status: "uncertain" }])
  })

  test("an answer that is not the sent message is uncertain, never a success", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 200, json: {} })
    f.discord.route("GET", MESSAGES_PATH, { status: 200, json: [] })
    expect(await send()).toMatchObject({ code: "uncertain" })
    expect(f.ledger()).toMatchObject([{ status: "uncertain", message: null }])
  })

  test("a failing read-back is reported as failed, with no matches", async () => {
    f.discord.route("POST", MESSAGES_PATH, { status: 502, json: {} })
    f.discord.route("GET", MESSAGES_PATH, { status: 500, json: {} })
    expect(await send()).toMatchObject({ code: "uncertain", details: { matches: [], read_back: "failed" } })
  })
})
