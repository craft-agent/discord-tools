import { afterEach, beforeEach, expect, test } from "bun:test"
import { deleteMessage, ingestMessages } from "./ingest"
import { getCursor, markCurrent, markRechecked, reconcileCursorEdges, setCursorEdges } from "./mirror-cursors"
import { createTestMirror, type TestMirror } from "./mirror.testing"
import { SYNC_CHANNEL, SYNC_ME, syncMessage } from "./sync-fixtures.testing"

let t: TestMirror
beforeEach(() => {
  t = createTestMirror()
})
afterEach(() => {
  t.close()
})

test("reconciliation moves deleted edges inward while retaining coverage and timestamps", () => {
  t.write(() => {
    ingestMessages(
      t.mirror,
      { me: SYNC_ME, now: 1 },
      ["95", "96", "99", "100"].map((id) => syncMessage(id)),
      { reactions: false },
    )
    setCursorEdges(t.mirror, SYNC_CHANNEL, { newest: "100", oldest: "95", complete: true })
    markCurrent(t.mirror, SYNC_CHANNEL, 123)
    markRechecked(t.mirror, SYNC_CHANNEL, 456)
    deleteMessage(t.mirror, "100")
    deleteMessage(t.mirror, "95")
    reconcileCursorEdges(t.mirror, SYNC_CHANNEL)
  })
  expect(getCursor(t.mirror, SYNC_CHANNEL)).toEqual({
    newest: "99",
    oldest: "96",
    complete: true,
    syncedAt: 123,
    recheckedAt: 456,
  })
})

test("an empty channel clears both edges without changing incomplete coverage or freshness", () => {
  t.write(() => {
    setCursorEdges(t.mirror, SYNC_CHANNEL, { newest: "100", oldest: "95" })
    markCurrent(t.mirror, SYNC_CHANNEL, 123)
    reconcileCursorEdges(t.mirror, SYNC_CHANNEL)
  })
  expect(getCursor(t.mirror, SYNC_CHANNEL)).toEqual({
    newest: null,
    oldest: null,
    complete: false,
    syncedAt: 123,
    recheckedAt: null,
  })
})

test("aggregate edges retain integer precision, numeric ordering and channel isolation", () => {
  t.write(() => {
    ingestMessages(
      t.mirror,
      { me: SYNC_ME, now: 1 },
      [
        syncMessage("9"),
        syncMessage("100"),
        syncMessage("9007199254740993"),
        syncMessage("9223372036854775807", "2002"),
      ],
      { reactions: false },
    )
    reconcileCursorEdges(t.mirror, SYNC_CHANNEL)
  })
  expect(getCursor(t.mirror, SYNC_CHANNEL)).toEqual({
    newest: "9007199254740993",
    oldest: "9",
    complete: false,
    syncedAt: null,
    recheckedAt: null,
  })
  expect(getCursor(t.mirror, "2002")).toBeUndefined()
})

function storeBelowTheOldest(complete: boolean): void {
  t.write(() => {
    ingestMessages(
      t.mirror,
      { me: SYNC_ME, now: 1 },
      ["5", "50", "51", "60"].map((id) => syncMessage(id)),
      { reactions: false },
    )
    setCursorEdges(t.mirror, SYNC_CHANNEL, { newest: "60", oldest: "50", complete })
    reconcileCursorEdges(t.mirror, SYNC_CHANNEL)
  })
}

test("a message stored below an incomplete cursor's oldest does not move it", () => {
  storeBelowTheOldest(false)
  expect(getCursor(t.mirror, SYNC_CHANNEL)).toMatchObject({ newest: "60", oldest: "50", complete: false })
  t.write(() => {
    deleteMessage(t.mirror, "50")
    reconcileCursorEdges(t.mirror, SYNC_CHANNEL)
  })
  expect(getCursor(t.mirror, SYNC_CHANNEL)).toMatchObject({ newest: "60", oldest: "51" })
})

test("a complete history reconciles over every stored message", () => {
  storeBelowTheOldest(true)
  expect(getCursor(t.mirror, SYNC_CHANNEL)).toMatchObject({ newest: "60", oldest: "5", complete: true })
})

test("invalid ids do not alter an existing cursor or create another one", () => {
  t.write(() => {
    setCursorEdges(t.mirror, SYNC_CHANNEL, { newest: "100" })
    for (const channel of ["name", "0", "2001 OR 1=1", "9223372036854775808"]) reconcileCursorEdges(t.mirror, channel)
  })
  expect(getCursor(t.mirror, SYNC_CHANNEL)?.newest).toBe("100")
  expect(t.mirror.prepare("SELECT COUNT(*) AS count FROM cursors").get()?.count).toBe(1)
})
