import { afterEach, beforeEach, expect, test } from "bun:test"
import { FAKE_TOKEN, type Harness, createHarness } from "./client.testing"

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(() => harness.dispose())

test("a failed native loader reports the platform, masks the cause and sends nothing", async () => {
  let loads = 0
  const client = harness.another({
    transport: undefined,
    loadTransport: async () => {
      loads += 1
      throw new Error(`Cannot load ${FAKE_TOKEN}\nprivate second line`)
    },
  })
  const expected = {
    code: "internal_error",
    message: `The network library could not be loaded for ${process.platform}-${process.arch}: Cannot load <token>`,
  }
  await expect(client.read("GET", "/users/@me")).rejects.toMatchObject(expected)
  await harness.warm()
  await expect(client.write("POST", "/channels/2/messages")).rejects.toMatchObject(expected)
  expect(loads).toBe(2)
  expect(harness.discord.requests).toHaveLength(0)
  expect(harness.sentAt).toHaveLength(0)
})
