import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getSend, recordSend, SEND_LEDGER_DAYS, settleSend, textHash } from "./ingest"
import { columnOf, createTestMirror, rowsOf, type TestMirror } from "./mirror.testing"
import { CHANNEL, ctxAt, msgId, NOW } from "./objects.testing"

let t: TestMirror

const NONCE = msgId(1)
const REPLY = msgId(2)
const MESSAGE = msgId(3)
const TEXT = "A private answer 🔒"
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

function record(nonce = NONCE, now = NOW): void {
  t.write(() => recordSend(t.mirror, ctxAt(now), { nonce, channel: CHANNEL, text: TEXT }))
}

describe("textHash", () => {
  test("hashes UTF-8 text as SHA-256 hex", () => {
    expect(textHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(textHash("🔒")).toBe("6ae1d2ee2e9592ea2e665661450a09fed95f7652324c4801c47aafe618daf96f")
  })
})

describe("recordSend", () => {
  test("records a pending row with a hash, never the text", () => {
    record()
    expect(getSend(t.mirror, NONCE)).toEqual({
      nonce: NONCE,
      channel: CHANNEL,
      replyTo: null,
      textHash: textHash(TEXT),
      created: NOW,
      status: "pending",
      message: null,
      code: null,
      settled: null,
    })
    const row = rowsOf(
      t.mirror,
      "SELECT CAST(nonce AS TEXT) AS nonce, CAST(channel AS TEXT) AS channel, reply_to, text_hash, created, status, message, code, settled FROM sends",
    )[0]
    expect(Object.keys(row)).toEqual([
      "nonce",
      "channel",
      "reply_to",
      "text_hash",
      "created",
      "status",
      "message",
      "code",
      "settled",
    ])
    expect(JSON.stringify(row)).not.toContain(TEXT)
    expect(columnOf(t.mirror, "SELECT name FROM pragma_table_info('sends')")).toEqual(Object.keys(row))
  })

  test("prunes settled and unsettled rows older than 30 days, keeping the cutoff and newer rows", () => {
    expect(SEND_LEDGER_DAYS).toBe(30)
    const cutoff = NOW - SEND_LEDGER_DAYS * DAY_MS
    const oldSettled = msgId(4)
    const boundary = msgId(5)
    const newer = msgId(6)
    record(NONCE, cutoff - 1)
    record(oldSettled, cutoff - 1)
    t.write(() => settleSend(t.mirror, ctxAt(NOW), oldSettled, { status: "uncertain", code: "uncertain" }))
    record(boundary, cutoff)
    record(newer, cutoff + 1)
    record(msgId(7))
    expect(getSend(t.mirror, NONCE)).toBeUndefined()
    expect(getSend(t.mirror, oldSettled)).toBeUndefined()
    expect(getSend(t.mirror, boundary)?.created).toBe(cutoff)
    expect(getSend(t.mirror, newer)?.created).toBe(cutoff + 1)
    expect(getSend(t.mirror, msgId(7))?.created).toBe(NOW)
  })

  test("runs inside the caller's transaction without committing it", () => {
    t.mirror.exec("BEGIN IMMEDIATE")
    recordSend(t.mirror, ctxAt(), { nonce: NONCE, channel: CHANNEL, text: TEXT })
    settleSend(t.mirror, ctxAt(NOW + 1), NONCE, { status: "sent", message: MESSAGE })
    expect(t.mirror.isTransaction).toBe(true)
    expect(getSend(t.mirror, NONCE)?.status).toBe("sent")
    t.mirror.exec("ROLLBACK")
    expect(getSend(t.mirror, NONCE)).toBeUndefined()
  })

  test("skips invalid ids rather than throwing a non-database error, and says so", () => {
    for (const send of [
      { nonce: "invalid", channel: CHANNEL, text: TEXT },
      { nonce: NONCE, channel: "invalid", text: TEXT },
      { nonce: NONCE, channel: CHANNEL, replyTo: "invalid", text: TEXT },
    ]) {
      expect(t.write(() => recordSend(t.mirror, ctxAt(), send))).toBe(false)
    }
    expect(getSend(t.mirror, NONCE)).toBeUndefined()
    expect(getSend(t.mirror, "invalid")).toBeUndefined()
    record()
    t.write(() => settleSend(t.mirror, ctxAt(), "invalid", { status: "sent", message: MESSAGE }))
    t.write(() => settleSend(t.mirror, ctxAt(), NONCE, { status: "sent", message: "invalid" }))
    expect(getSend(t.mirror, NONCE)?.status).toBe("pending")
  })
})

describe("settleSend", () => {
  test("settles a sent row with the message id and settlement time", () => {
    record()
    t.write(() => settleSend(t.mirror, ctxAt(NOW + 1), NONCE, { status: "sent", message: MESSAGE }))
    expect(getSend(t.mirror, NONCE)).toMatchObject({
      status: "sent",
      message: MESSAGE,
      code: null,
      created: NOW,
      settled: NOW + 1,
    })
  })

  test.each(["not_sent", "uncertain"] as const)("settles %s with an error code", (status) => {
    record()
    t.write(() => settleSend(t.mirror, ctxAt(NOW + 2), NONCE, { status, code: "upstream_error" }))
    expect(getSend(t.mirror, NONCE)).toMatchObject({
      status,
      message: null,
      code: "upstream_error",
      created: NOW,
      settled: NOW + 2,
    })
  })

  test.each(["sent", "not_sent", "uncertain"] as const)("never overwrites a %s row", (status) => {
    record()
    const outcome = status === "sent" ? { status, message: MESSAGE } : { status, code: "upstream_error" }
    t.write(() => settleSend(t.mirror, ctxAt(NOW + 1), NONCE, outcome))
    const settled = getSend(t.mirror, NONCE)
    t.write(() => settleSend(t.mirror, ctxAt(NOW + 2), NONCE, { status: "sent", message: msgId(9) }))
    t.write(() => settleSend(t.mirror, ctxAt(NOW + 3), NONCE, { status: "not_sent", code: "forbidden" }))
    expect(getSend(t.mirror, NONCE)).toEqual(settled)
  })

  test("an unknown nonce changes nothing", () => {
    t.write(() => settleSend(t.mirror, ctxAt(), NONCE, { status: "uncertain", code: "uncertain" }))
    expect(getSend(t.mirror, NONCE)).toBeUndefined()
    expect(rowsOf(t.mirror, "SELECT * FROM sends")).toEqual([])
  })
})

describe("getSend", () => {
  test("round-trips every id above 2^53 as text", () => {
    t.write(() => recordSend(t.mirror, ctxAt(), { nonce: NONCE, channel: CHANNEL, replyTo: REPLY, text: TEXT }))
    t.write(() => settleSend(t.mirror, ctxAt(), NONCE, { status: "sent", message: MESSAGE }))
    expect(getSend(t.mirror, NONCE)).toMatchObject({
      nonce: NONCE,
      channel: CHANNEL,
      replyTo: REPLY,
      message: MESSAGE,
    })
    for (const id of [NONCE, CHANNEL, REPLY, MESSAGE]) expect(BigInt(id)).toBeGreaterThan(2n ** 53n)
    expect(
      rowsOf(t.mirror, "SELECT typeof(nonce), typeof(channel), typeof(reply_to), typeof(message) FROM sends"),
    ).toEqual([
      {
        "typeof(nonce)": "integer",
        "typeof(channel)": "integer",
        "typeof(reply_to)": "integer",
        "typeof(message)": "integer",
      },
    ])
  })
})
