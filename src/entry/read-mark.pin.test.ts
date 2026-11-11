import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OWN } from "../core/actions/actions.testing"
import { failure } from "../core/chats/read.testing"
import { ingestMessages } from "../core/discord/ingest"
import { CHANNEL, messageObject, msgId } from "../core/discord/objects.testing"
import { discordReadMark } from "../core/read-mark/read-mark-tool"
import { createReadMarkFixture, type ReadMarkFixture } from "../core/read-mark/read-mark.testing"
import { approvalOf, checkPin } from "./pin"

let f: ReadMarkFixture

beforeEach(async () => {
  f = await createReadMarkFixture()
})

afterEach(() => f.dispose())

const defaulted = { channel: CHANNEL }
const named = { channel: CHANNEL, message: OWN }

/** Mirrors a message of the chat newer than any it holds, as a sync run would after the prompt. */
const arrive = (id = msgId(50), content = "a newer message") =>
  f.seed((m) => ingestMessages(m, f.ingestContext(), [messageObject(id, CHANNEL, { content })], { reactions: true }))

describe("the pin of a read mark", () => {
  test("holds while the newest message is the one the prompt showed", async () => {
    const { pin } = await approvalOf(discordReadMark, defaulted, f.ctx)
    expect(pin).toBeDefined()
    await expect(checkPin(discordReadMark, defaulted, f.ctx, pin)).resolves.toBeUndefined()
  })

  test("is stale when a newer message arrived after the prompt, and nothing is requested", async () => {
    const { pin } = await approvalOf(discordReadMark, defaulted, f.ctx)
    arrive()
    expect(await failure(checkPin(discordReadMark, defaulted, f.ctx, pin))).toMatchObject({ code: "stale" })
    expect(f.discord.api).toEqual([])
  })

  test("is stale for a newer message that reads the same as the one shown", async () => {
    arrive(msgId(50), "same start")
    const { pin } = await approvalOf(discordReadMark, defaulted, f.ctx)
    arrive(msgId(51), "same start")
    expect(await failure(checkPin(discordReadMark, defaulted, f.ctx, pin))).toMatchObject({ code: "stale" })
  })

  test("is asked again on the next call, which pins the newer message", async () => {
    const first = await approvalOf(discordReadMark, defaulted, f.ctx)
    arrive()
    const second = await approvalOf(discordReadMark, defaulted, f.ctx)
    expect(second.pin).not.toBe(first.pin)
    await expect(checkPin(discordReadMark, defaulted, f.ctx, second.pin)).resolves.toBeUndefined()
  })

  test("holds for a named message when newer ones arrive, since the person saw that message", async () => {
    const { pin } = await approvalOf(discordReadMark, named, f.ctx)
    arrive()
    await expect(checkPin(discordReadMark, named, f.ctx, pin)).resolves.toBeUndefined()
  })
})
