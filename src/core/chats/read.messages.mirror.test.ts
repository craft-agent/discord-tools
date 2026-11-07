import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestMessages } from "../discord/ingest"
import { CURRENT_MS } from "../discord/mirror-cursors"
import { CHANNEL, messageObject, msgId, OTHER_CHANNEL } from "../discord/objects.testing"
import { UNTRUSTED_NOTE } from "./format"
import { createChatFixture, failure, type ChatFixture } from "./read.testing"
import {
  CATEGORY,
  FORUM,
  history,
  historyRequests,
  idsOf,
  messageIds,
  seedChannels,
  seedHistory,
  serveHistory,
} from "./read.messages.testing"

let f: ChatFixture
beforeEach(async () => {
  f = await createChatFixture()
  seedChannels(f)
})
afterEach(async () => {
  await f.dispose()
})

const messages = (args: Record<string, unknown> = {}) => f.read({ method: "messages", channel: CHANNEL, ...args })

describe("method messages from the mirror", () => {
  test("a current, complete channel answers oldest first with no request and no token", async () => {
    seedHistory(f, [1, 2, 3, 4, 5], { current: true, complete: true })
    f.ctx.runtime!.env = {}
    const result = await messages()
    expect(result).toMatchObject({ method: "messages", source: "mirror", channel: CHANNEL, note: UNTRUSTED_NOTE })
    expect(messageIds(result)).toEqual(idsOf(1, 2, 3, 4, 5))
    expect(result.next_before).toBeNull()
    expect(result.next_after).toBeNull()
    expect(result).not.toHaveProperty("reactions_note")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("pages back with next_before across the mirror", async () => {
    seedHistory(f, [1, 2, 3, 4, 5], { current: true, complete: true })
    const first = await messages({ limit: 2 })
    expect(messageIds(first)).toEqual(idsOf(4, 5))
    expect(first.next_before).toBe(idsOf(4)[0]!)
    const second = await messages({ limit: 2, before: first.next_before })
    expect(messageIds(second)).toEqual(idsOf(2, 3))
    const third = await messages({ limit: 2, before: second.next_before })
    expect(messageIds(third)).toEqual(idsOf(1))
    expect(third.next_before).toBeNull()
    expect([first, second, third].map((page) => page.source)).toEqual(["mirror", "mirror", "mirror"])
    expect(f.discord.requests).toHaveLength(0)
  })

  test("an incomplete channel answers a full page, and says older messages may exist below its oldest", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    const result = await messages({ limit: 3 })
    expect(result.source).toBe("mirror")
    expect(messageIds(result)).toEqual(idsOf(3, 4, 5))
    expect(result.next_before).toBe(idsOf(3)[0]!)
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a floor inside the vouched range is covered even when the page is short", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    const result = await messages({ after: idsOf(2)[0] })
    expect(result.source).toBe("mirror")
    expect(messageIds(result)).toEqual(idsOf(3, 4, 5))
    expect(result.next_before).toBeNull()
    expect(messageIds(await messages({ after: idsOf(3)[0], before: idsOf(5)[0] }))).toEqual(idsOf(4))
  })

  test("forward with after reads the oldest messages above it and pages with next_after", async () => {
    seedHistory(f, [1, 2, 3, 4, 5], { current: true, complete: true })
    const first = await messages({ after: idsOf(1)[0], limit: 2 })
    expect(first).toMatchObject({ source: "mirror", next_before: null, next_after: idsOf(3)[0] })
    expect(messageIds(first)).toEqual(idsOf(2, 3))
    const second = await messages({ after: first.next_after, limit: 2 })
    expect(messageIds(second)).toEqual(idsOf(4, 5))
    expect(second.next_after).toBeNull()
    expect(f.discord.requests).toHaveLength(0)
  })

  test("forward on an incomplete channel is served only from the oldest mirrored message up", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    expect(messageIds(await messages({ after: idsOf(2)[0] }))).toEqual(idsOf(3, 4, 5))
    expect(f.discord.requests).toHaveLength(0)
    serveHistory(f, history(1, 2, 3, 4, 5))
    const below = await messages({ after: idsOf(1)[0] })
    expect(below.source).toBe("live")
    expect(messageIds(below)).toEqual(idsOf(2, 3, 4, 5))
  })

  test("a message stored above the cursor's newest is not returned, in either direction", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    f.seed((m) => ingestMessages(m, f.ingestContext(), [messageObject(msgId(9), CHANNEL)], { reactions: false }))
    const latest = await messages({ limit: 3 })
    expect(latest.source).toBe("mirror")
    expect(messageIds(latest)).toEqual(idsOf(3, 4, 5))
    const forward = await messages({ after: idsOf(2)[0], limit: 10 })
    expect(forward.source).toBe("mirror")
    expect(messageIds(forward)).toEqual(idsOf(3, 4, 5))
    expect(forward.next_after).toBeNull()
    expect(f.discord.requests).toHaveLength(0)
  })

  test("falls to Discord when the channel is not current, when live is true and when the request reaches below the oldest", async () => {
    seedHistory(f, [3, 4, 5], { current: true })
    serveHistory(f, history(1, 2, 3, 4, 5))
    const below = await messages({ before: idsOf(4)[0] })
    expect(below.source).toBe("live")
    expect(messageIds(below)).toEqual(idsOf(1, 2, 3))
    const forced = await messages({ limit: 3, live: true })
    expect(forced.source).toBe("live")
    f.advance(CURRENT_MS + 1)
    expect((await messages({ limit: 3 })).source).toBe("live")
    expect(historyRequests(f)).toHaveLength(3)
  })

  test("a channel never marked current is read from Discord", async () => {
    seedHistory(f, [1, 2], { complete: true })
    serveHistory(f, history(1, 2))
    expect((await messages()).source).toBe("live")
    expect(historyRequests(f)).toHaveLength(1)
  })

  test("limit is at most 100 and defaults to 50", async () => {
    seedHistory(
      f,
      Array.from({ length: 120 }, (_, i) => i + 1),
      { current: true, complete: true },
    )
    const error = await failure(messages({ limit: 101 }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("at most 100")
    expect(messageIds(await messages({ limit: 100 }))).toHaveLength(100)
    const dflt = await messages()
    expect(messageIds(dflt)).toEqual(idsOf(...Array.from({ length: 50 }, (_, i) => i + 71)))
    expect(dflt.next_before).toBe(idsOf(71)[0]!)
    expect(f.discord.requests).toHaveLength(0)
  })
})

describe("method messages: the channel", () => {
  test("a channel the mirror does not know is not_found, with no request", async () => {
    const error = await failure(messages({ channel: OTHER_CHANNEL }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("method dms, channels or threads")
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a forum and a category hold no messages", async () => {
    for (const channel of [FORUM, CATEGORY]) {
      const error = await failure(messages({ channel }))
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("holds no messages")
    }
    expect(f.discord.requests).toHaveLength(0)
  })

  test("a missing channel, a name and a message argument are refused", async () => {
    expect((await failure(f.read({ method: "messages" }))).message).toContain("needs `channel`")
    expect((await failure(messages({ channel: "general" }))).code).toBe("invalid_argument")
    expect((await failure(messages({ message: idsOf(1)[0] }))).message).toContain("message is not an argument")
    expect((await failure(messages({ before: "yesterday" }))).message).toContain("a message id")
    expect((await failure(messages({ before: idsOf(1)[0], after: idsOf(1)[0] }))).code).toBe("invalid_argument")
    expect(f.discord.requests).toHaveLength(0)
  })
})
