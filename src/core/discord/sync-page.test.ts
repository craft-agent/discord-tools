import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestHistoryPage } from "./ingest"
import { CHANNEL, channelObject, ctxAt, messageObject, msgId, OTHER_CHANNEL, SERVER } from "./objects.testing"
import { channelRecords, forwardPage } from "./sync-page"
import { createTestMirror, errorOf, storedMessageIds, type TestMirror } from "./mirror.testing"

let t: TestMirror
beforeEach(() => {
  t = createTestMirror()
})
afterEach(() => {
  t.close()
})

const message = (n: number, channel = CHANNEL) => messageObject(msgId(n), channel)

describe("channelRecords", () => {
  test("a server's list holds no DM or group DM, a private list does", () => {
    for (const type of [1, 3]) {
      const rows = [channelObject(CHANNEL, { type })]
      expect(errorOf(() => channelRecords(rows, SERVER))).toMatchObject({ code: "upstream_error" })
      expect(channelRecords(rows)).toEqual(rows)
    }
    const text = [channelObject(CHANNEL, { guild_id: SERVER })]
    expect(channelRecords(text, SERVER)).toEqual(text)
  })
})

describe("forwardPage", () => {
  test("a full newest-first page vouches strictly between after and one above its newest", () => {
    const page = forwardPage([message(14), message(13), message(12)], CHANNEL, 3, msgId(10))
    expect(page.messages.map((m) => m.id)).toEqual([msgId(14), msgId(13), msgId(12)])
    expect(page.newest).toBe(msgId(14))
    expect(page.oldest).toBe(msgId(12))
    expect(page.complete).toBe(false)
    expect(page.range).toEqual({ after: msgId(10), before: msgId(15) })
  })

  test("a short page is complete", () => {
    expect(forwardPage([message(12)], CHANNEL, 3, msgId(10)).complete).toBe(true)
  })

  test("a page deletes what is mirrored inside its range and returned nowhere, and nothing outside", () => {
    t.write(() => {
      ingestHistoryPage(
        t.mirror,
        ctxAt(),
        CHANNEL,
        [11, 12, 13, 14, 16].map((n) => message(n)),
        {
          after: "0",
          before: msgId(17),
        },
      )
      const page = forwardPage([message(14), message(12)], CHANNEL, 2, msgId(10))
      ingestHistoryPage(t.mirror, ctxAt(), CHANNEL, page.messages, page.range)
    })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(12), msgId(14), msgId(16)])
  })

  test("an empty page vouches for nothing", () => {
    const page = forwardPage([], CHANNEL, 3, msgId(10))
    expect(page.messages).toEqual([])
    expect(page.range).toEqual({ after: msgId(10), before: msgId(10) })
    t.write(() => {
      ingestHistoryPage(
        t.mirror,
        ctxAt(),
        CHANNEL,
        [11, 12].map((n) => message(n)),
        { after: "0", before: msgId(13) },
      )
      ingestHistoryPage(t.mirror, ctxAt(), CHANNEL, page.messages, page.range)
      const fromStart = forwardPage([], CHANNEL, 3, "0")
      ingestHistoryPage(t.mirror, ctxAt(), CHANNEL, fromStart.messages, fromStart.range)
    })
    expect(storedMessageIds(t.mirror, CHANNEL)).toEqual([msgId(11), msgId(12)])
  })

  test.each([
    ["not a list", { message: "oops" }],
    ["more than the limit", [message(14), message(13), message(12), message(11)]],
    ["a message at after", [message(12), message(10)]],
    ["a message below after", [message(12), message(9)]],
    ["oldest first", [message(11), message(12)]],
    ["a repeated id", [message(12), message(12)]],
    ["another channel", [message(12, OTHER_CHANNEL)]],
    ["text that is not a string", [{ ...message(12), content: 5 }]],
    ["an id that is not a snowflake", [{ ...message(12), id: "abc" }]],
  ])("refuses %s", (_name, value) => {
    const error = errorOf(() => forwardPage(value, CHANNEL, 3, msgId(10)))
    expect(error).toMatchObject({ code: "upstream_error" })
  })
})
