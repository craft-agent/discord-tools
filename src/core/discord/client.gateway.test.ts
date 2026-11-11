import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { BudgetSpent } from "./client"
import { type Harness, FAKE_TOKEN, createHarness } from "./client.testing"
import { FakeGateway, OP_HELLO, OP_IDENTIFY, isOp, readyData } from "./fake-gateway.testing"
import { headerOf } from "./fake-discord.testing"
import { GATEWAY_URL, IDENTIFY_CAPABILITIES } from "./gateway"
import { GATEWAY_HEADER_ORDER } from "./request-headers"

const TIMEOUT_MS = 5000
const BIG_ID = "1234567890123456789"

let harness: Harness
let gateway: FakeGateway

beforeEach(async () => {
  gateway = new FakeGateway()
  harness = await createHarness({ socket: gateway.transport })
  await harness.warm()
  harness.discord.route("GET", "/users/@me", { status: 200, json: { id: "1" } })
})

afterEach(() => harness.dispose())

describe("gatewayReady", () => {
  test("connects as the web client, sends only Identify and closes with 1000", async () => {
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })

    expect(gateway.requests).toHaveLength(1)
    const request = gateway.requests[0]!
    expect(request.url).toBe(GATEWAY_URL)
    expect(request.url).toBe("wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream")
    expect(request.headers.map(([name]) => name)).toEqual([...GATEWAY_HEADER_ORDER])
    expect(Object.fromEntries(request.headers)).toMatchObject({
      origin: "https://discord.com",
      pragma: "no-cache",
      "cache-control": "no-cache",
      "accept-language": expect.any(String),
      "user-agent": expect.stringContaining("Chrome/"),
    })
    expect(request.maxMessageSize).toBeGreaterThanOrEqual(64 * 1024 * 1024)

    expect(gateway.sent).toHaveLength(1)
    expect(gateway.sent[0]).toEqual({
      op: OP_IDENTIFY,
      d: {
        token: FAKE_TOKEN,
        capabilities: IDENTIFY_CAPABILITIES,
        properties: expect.any(Object),
        presence: { status: "unknown", since: 0, activities: [], afk: false },
        compress: false,
        client_state: { guild_versions: {} },
      },
    })
    expect(IDENTIFY_CAPABILITIES & (1 << 2)).toBe(1 << 2)
    expect(gateway.closes).toEqual([1000])
    expect(gateway.sockets[0]!.isClosed).toBe(true)
  })

  test("carries no token in the upgrade request", async () => {
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    const request = gateway.requests[0]!
    expect(request.headers.some(([name]) => name === "authorization")).toBe(false)
    expect(JSON.stringify(request)).not.toContain(FAKE_TOKEN)
  })

  test("identifies with the properties the HTTP client encodes in X-Super-Properties", async () => {
    await harness.client.read("GET", "/users/@me")
    const encoded = headerOf(harness.discord.api[0]!, "x-super-properties")!
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    const identify = gateway.sent[0] as { d: { properties: unknown } }
    expect(identify.d.properties).toEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")))
  })

  test("reads the channels' read states, keeps ids as strings and defaults mentions to 0", async () => {
    gateway.readyData = readyData(
      [
        { id: BIG_ID, last_message_id: "1234567890123456790", mention_count: 3, flags: 2 },
        { id: "222", read_state_type: 0 },
        { id: "333", last_message_id: null, mention_count: null, badge_count: 9 },
        { id: "444", read_state_type: 1, mention_count: 5 },
        { id: "not-an-id" },
        "garbage",
      ],
      { partial: true, userId: BIG_ID },
    )
    const ready = await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(ready).toEqual({
      userId: BIG_ID,
      partial: true,
      ms: 0,
      readStates: [
        { channel: BIG_ID, lastRead: "1234567890123456790", mentions: 3, flags: 2 },
        { channel: "222", lastRead: null, mentions: 0, flags: 0 },
        { channel: "333", lastRead: null, mentions: 0, flags: 0 },
      ],
    })
  })

  test("measures the time from the upgrade to READY", async () => {
    gateway.onSend = (frame, control) => {
      if (!isOp(frame, OP_IDENTIFY)) return
      harness.advance(250)
      return control.ready()
    }
    const ready = await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(ready.ms).toBe(250)
  })

  test("sends no heartbeat even when Hello asks for one at once", async () => {
    gateway.onOpen = (control) => control.hello(1)
    gateway.onSend = async (frame, control) => {
      if (!isOp(frame, OP_IDENTIFY)) return
      await new Promise((resolve) => setTimeout(resolve, 30))
      await control.ready()
    }
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(gateway.sent.map((frame) => (frame as { op: number }).op)).toEqual([OP_IDENTIFY])
  })

  test("sends Identify once however often Hello comes, and ignores other payloads", async () => {
    gateway.onOpen = async (control) => {
      await control.hello()
      await control.payload({ op: 11 })
      await control.hello()
      await control.payload({ op: 0, t: "SESSIONS_REPLACE", d: [] })
      await control.payload({ op: 1, d: null })
    }
    gateway.onSend = async (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) await control.ready()
    }
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(gateway.sent.filter((frame) => isOp(frame, OP_IDENTIFY))).toHaveLength(1)
    expect(gateway.sent).toHaveLength(1)
  })

  test("reads one zlib context over several frames and a payload split over frames", async () => {
    const entries = Array.from({ length: 2000 }, (_, i) => ({ id: String(1000 + i), mention_count: i % 3 }))
    gateway.onOpen = async (control) => {
      await control.payload({ op: OP_HELLO, d: { heartbeat_interval: 41_250 } }, 3)
    }
    gateway.onSend = async (frame, control) => {
      if (!isOp(frame, OP_IDENTIFY)) return
      await control.payload({ op: 0, t: "READY_SUPPLEMENTAL", d: { padding: "x".repeat(20_000) } }, 2)
      await control.payload({ op: 0, t: "READY", d: readyData(entries) }, 7)
    }
    const ready = await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(ready.readStates).toHaveLength(2000)
    expect(ready.readStates[1999]).toEqual({ channel: "2999", lastRead: null, mentions: 1, flags: 0 })
  })

  test("takes uncompressed text frames too", async () => {
    gateway.onOpen = (control) => control.raw(JSON.stringify({ op: OP_HELLO, d: { heartbeat_interval: 1 } }))
    gateway.onSend = (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) control.raw(JSON.stringify({ op: 0, t: "READY", d: readyData([{ id: "9" }]) }))
    }
    const ready = await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(ready.readStates).toEqual([{ channel: "9", lastRead: null, mentions: 0, flags: 0 }])
  })
})

describe("gatewayReady as a request", () => {
  test("is paced after the last request of the process", async () => {
    await harness.client.read("GET", "/users/@me")
    harness.sleeps.length = 0
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(harness.sleeps).toEqual([1100])
  })

  test("counts as one request, the build number page apart", async () => {
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(harness.client.requests).toBe(1)
    await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    expect(harness.client.requests).toBe(2)
    expect(gateway.requests).toHaveLength(2)
  })

  test("is refused, before anything is opened, when the budget is spent", async () => {
    const client = harness.another({ budget: 1 })
    await client.gatewayReady({ timeoutMs: TIMEOUT_MS })
    await expect(client.gatewayReady({ timeoutMs: TIMEOUT_MS })).rejects.toBeInstanceOf(BudgetSpent)
    expect(gateway.requests).toHaveLength(1)
  })

  test("is not retried when it fails to open", async () => {
    gateway.failOpen = new Error("connection reset")
    await expect(harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("connection reset"),
    })
    expect(gateway.requests).toHaveLength(1)
    expect(harness.client.requests).toBe(1)
  })
})
