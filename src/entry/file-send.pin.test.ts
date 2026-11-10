import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../core/chats/read.testing"
import { CHANNEL } from "../core/discord/objects.testing"
import { createFileSendFixture, type FileSendFixture } from "../core/sends/file-send.testing"
import { discordFileSend } from "../core/sends/file-send-tool"
import { approvalOf, checkPin } from "./pin"

let f: FileSendFixture

beforeEach(async () => {
  f = await createFileSendFixture()
  await f.files.write("work/a.txt", "first")
  await f.files.write("work/b.txt", "second")
})

afterEach(() => f.dispose())

const args = { channel: CHANNEL, files: ["a.txt", "b.txt"], text: "hi" }

describe("the pin of a file send", () => {
  test("holds while the files are as they were when the prompt was drawn", async () => {
    const { pin } = await approvalOf(discordFileSend, args, f.ctx)
    expect(pin).toBeDefined()
    await expect(checkPin(discordFileSend, args, f.ctx, pin)).resolves.toBeUndefined()
  })

  test("is stale when a file changed after the prompt, even to the same size, and nothing is requested", async () => {
    const { pin } = await approvalOf(discordFileSend, args, f.ctx)
    await f.files.write("work/b.txt", "SECOND")
    expect(await failure(checkPin(discordFileSend, args, f.ctx, pin))).toMatchObject({ code: "stale" })
    expect(f.untouched()).toBe(true)
    expect(f.ledger()).toEqual([])
  })

  test("is stale when a file can no longer be sent", async () => {
    const { pin } = await approvalOf(discordFileSend, args, f.ctx)
    await f.files.write("work/a.txt", "")
    expect(await failure(checkPin(discordFileSend, args, f.ctx, pin))).toMatchObject({ code: "stale" })
  })

  test("is stale when the files are listed in another order", async () => {
    const { pin } = await approvalOf(discordFileSend, args, f.ctx)
    const swapped = { ...args, files: ["b.txt", "a.txt"] }
    expect(await failure(checkPin(discordFileSend, swapped, f.ctx, pin))).toMatchObject({ code: "stale" })
  })
})
