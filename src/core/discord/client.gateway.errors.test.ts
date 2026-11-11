import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { type Harness, FAKE_TOKEN, createHarness } from "./client.testing"
import { FakeGateway, OP_IDENTIFY, OP_INVALID_SESSION, isOp, readyData } from "./fake-gateway.testing"

const TIMEOUT_MS = 5000

let harness: Harness
let gateway: FakeGateway

beforeEach(async () => {
  gateway = new FakeGateway()
  harness = await createHarness({ socket: gateway.transport })
  await harness.warm()
})

afterEach(() => harness.dispose())

/** The error a gateway read ends with, after checking that the socket was closed by the time it settled. */
async function failure(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  const error = await harness.client
    .gatewayReady({ timeoutMs: options.timeoutMs ?? TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) })
    .then(
      () => {
        throw new Error("expected a failure")
      },
      (caught: unknown) => caught,
    )
  expect(gateway.sockets.every((socket) => socket.isClosed)).toBe(true)
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(FAKE_TOKEN)
  return error
}

describe("gatewayReady rejections", () => {
  test("close 4004 is a rejected token, recorded and thrown as a 401 is", async () => {
    gateway.onSend = (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) control.close(4004, "Authentication failed.")
    }
    expect(await failure()).toMatchObject({
      code: "unauthenticated",
      message: "Discord rejected the token (401); give this account a new token.",
    })
    expect(gateway.closes).toEqual([1000])
    expect(existsSync(harness.paths.auth)).toBe(true)
    expect(readFileSync(harness.paths.auth, "utf8")).not.toContain(FAKE_TOKEN)
  })

  test("after a 4004 every later request is refused without sending, as after a 401", async () => {
    gateway.onSend = (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) control.close(4004)
    }
    await failure()
    const opened = gateway.requests.length
    const expected = {
      code: "unauthenticated",
      message: `Discord rejected this account's token at ${new Date(harness.now()).toISOString()}; give it a new token.`,
    }
    await expect(harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })).rejects.toMatchObject(expected)
    await expect(harness.another().gatewayReady({ timeoutMs: TIMEOUT_MS })).rejects.toMatchObject(expected)
    await expect(harness.client.read("GET", "/users/@me")).rejects.toMatchObject(expected)
    expect(gateway.requests).toHaveLength(opened)
    expect(harness.discord.api).toHaveLength(0)
  })

  test("an invalid session before READY is transient: an upstream error that records nothing", async () => {
    gateway.onSend = async (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) await control.payload({ op: OP_INVALID_SESSION, d: false })
    }
    expect(await failure()).toMatchObject({
      code: "upstream_error",
      message: "Discord's gateway ended the session before READY (invalid session).",
    })
    expect(gateway.closes).toEqual([1000])
    expect(existsSync(harness.paths.auth)).toBe(false)

    gateway.onSend = (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) return control.ready()
    }
    expect((await harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS })).userId).toBeString()
  })

  test.each([4013, 4014, 4008, 4015, 1001])("close %d is an upstream error that names the code", async (code) => {
    gateway.onSend = (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) control.close(code, "because")
    }
    expect(await failure()).toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining(`code ${code}`),
    })
  })

  test("a close before Hello is an upstream error", async () => {
    gateway.onOpen = (control) => control.close(1006, "", "connection reset by peer")
    expect(await failure()).toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("connection reset by peer"),
    })
    expect(gateway.sent).toEqual([])
  })

  test("keeps the token out of a close reason", async () => {
    gateway.onSend = (frame, control) => {
      if (isOp(frame, OP_IDENTIFY)) control.close(4000, `bad ${FAKE_TOKEN} here`)
    }
    const error = (await failure()) as Error
    expect(error.message).toContain("code 4000")
    expect(error.message).not.toContain(FAKE_TOKEN)
  })

  test("keeps the token out of a failure to open", async () => {
    gateway.failOpen = new Error(`handshake with ${FAKE_TOKEN} failed`)
    const error = (await failure()) as Error
    expect(error.message).not.toContain(FAKE_TOKEN)
  })

  test("a READY without the read state is an upstream error", async () => {
    gateway.readyData = { user: { id: "1" } }
    expect(await failure()).toMatchObject({ code: "upstream_error", message: expect.stringContaining("READY") })
    expect(gateway.closes).toEqual([1000])
  })

  test("a READY without the account is an upstream error", async () => {
    gateway.readyData = { ...readyData(), user: {} }
    expect(await failure()).toMatchObject({ code: "upstream_error" })
  })

  test("a send that fails after Hello is an upstream error", async () => {
    gateway.onOpen = async (control) => {
      await control.hello()
      control.close(1006)
    }
    expect(await failure()).toMatchObject({ code: "upstream_error" })
  })
})

describe("gatewayReady garbage", () => {
  test.each([
    ["bytes that are not zlib", new Uint8Array([1, 2, 3, 4, 0, 0, 0xff, 0xff])],
    ["text that is not JSON", "{nope"],
    ["JSON that is not an object", "[1,2]"],
  ])("%s end the session and close the socket", async (_name, data) => {
    gateway.onOpen = (control) => control.raw(data)
    expect(await failure()).toMatchObject({ code: "upstream_error", message: expect.stringContaining("read") })
    expect(gateway.closes).toEqual([1000])
  })

  test("a payload that never ends is not waited for beyond the time limit", async () => {
    gateway.onOpen = (control) => control.raw(new Uint8Array([0x78, 0x9c, 1, 2, 3]))
    expect(await failure({ timeoutMs: 40 })).toMatchObject({ code: "upstream_error" })
    expect(gateway.closes).toEqual([1000])
  })
})

describe("gatewayReady time and cancellation", () => {
  test("gives up without READY after the time limit", async () => {
    gateway.onSend = () => {}
    expect(await failure({ timeoutMs: 40 })).toMatchObject({
      code: "upstream_error",
      message: "Discord's gateway sent no READY within 0.04 s.",
    })
    expect(gateway.closes).toEqual([1000])
  })

  test("rejects a time limit that is not positive, before anything is opened", async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      await expect(harness.client.gatewayReady({ timeoutMs })).rejects.toMatchObject({ code: "internal_error" })
    }
    expect(gateway.requests).toHaveLength(0)
  })

  test("an abort while waiting closes the socket and rejects with an AbortError", async () => {
    gateway.onSend = () => {}
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    expect(await failure({ signal: controller.signal })).toMatchObject({ name: "AbortError" })
    expect(gateway.closes).toEqual([1000])
  })

  test("an abort before the call opens nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      harness.client.gatewayReady({ timeoutMs: TIMEOUT_MS, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(gateway.requests).toHaveLength(0)
  })
})
