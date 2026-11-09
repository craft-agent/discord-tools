import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ingestMessages, setPinned } from "./ingest"
import { createTestMirror, rowById, type TestMirror } from "./mirror.testing"
import { CHANNEL, ctxAt, messageObject, msgId } from "./objects.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
  t.write(() =>
    ingestMessages(
      t.mirror,
      ctxAt(),
      [messageObject(msgId(1), CHANNEL), messageObject(msgId(2), CHANNEL, { pinned: true })],
      { reactions: false },
    ),
  )
})

afterEach(() => t.close())

const pinned = (id: string) => rowById(t.mirror, "messages", id)!.pinned
const set = (id: string, value: boolean) => t.write(() => setPinned(t.mirror, id, value))

describe("setPinned", () => {
  test("pins a message that was not pinned", () => {
    expect(set(msgId(1), true)).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(pinned(msgId(1))).toBe(1)
  })

  test("unpins a message that was pinned", () => {
    expect(set(msgId(2), false)).toEqual({ stored: 1, deleted: 0, skipped: 0 })
    expect(pinned(msgId(2))).toBe(0)
  })

  test("a message already in that state changes nothing", () => {
    expect(set(msgId(1), false)).toEqual({ stored: 0, deleted: 0, skipped: 0 })
    expect(set(msgId(2), true)).toEqual({ stored: 0, deleted: 0, skipped: 0 })
    expect(pinned(msgId(1))).toBe(0)
    expect(pinned(msgId(2))).toBe(1)
  })

  test("a message the mirror does not hold, or an invalid id, is skipped", () => {
    expect(set(msgId(9), true)).toEqual({ stored: 0, deleted: 0, skipped: 1 })
    expect(set("latest", true)).toEqual({ stored: 0, deleted: 0, skipped: 1 })
  })
})
