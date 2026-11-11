import { describe, expect, test } from "bun:test"
import { ZlibEncoder } from "./fake-gateway.testing"
import { createGatewayInflater } from "./gateway-inflate"

const LIMITS = { maxPackedBytes: 1024 * 1024, maxUnpackedBytes: 1024 * 1024 }

describe("createGatewayInflater", () => {
  test("unpacks payloads that share one zlib context", async () => {
    const encoder = new ZlibEncoder()
    const inflater = createGatewayInflater(LIMITS)
    for (const text of ['{"op":10}', "é".repeat(5000), "[]"]) {
      expect(await inflater.push(await encoder.encode(text))).toBe(text)
    }
    inflater.end()
    encoder.end()
  })

  test("waits for the end of a payload that spans frames, even when the marker itself is split", async () => {
    const encoder = new ZlibEncoder()
    const inflater = createGatewayInflater(LIMITS)
    const text = JSON.stringify({ padding: "z".repeat(3000), n: [1, 2, 3] })
    const bytes = await encoder.encode(text)
    expect(await inflater.push(bytes.subarray(0, 10))).toBeUndefined()
    expect(await inflater.push(bytes.subarray(10, bytes.length - 2))).toBeUndefined()
    expect(await inflater.push(bytes.subarray(bytes.length - 2))).toBe(text)
    inflater.end()
    encoder.end()
  })

  test("refuses a payload that unpacks past the limit", async () => {
    const encoder = new ZlibEncoder()
    const inflater = createGatewayInflater({ ...LIMITS, maxUnpackedBytes: 1000 })
    await expect(inflater.push(await encoder.encode("a".repeat(50_000)))).rejects.toThrow()
    inflater.end()
    encoder.end()
  })

  test("refuses frames that pile up past the limit", async () => {
    const inflater = createGatewayInflater({ ...LIMITS, maxPackedBytes: 8 })
    expect(await inflater.push(new Uint8Array(5))).toBeUndefined()
    await expect(inflater.push(new Uint8Array(5))).rejects.toThrow()
    inflater.end()
  })

  test("refuses data that is not zlib", async () => {
    const inflater = createGatewayInflater(LIMITS)
    await expect(inflater.push(new Uint8Array([9, 9, 9, 0, 0, 0xff, 0xff]))).rejects.toThrow()
    inflater.end()
  })
})
