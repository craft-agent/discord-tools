import { afterEach, describe, expect, test } from "bun:test"
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { getEmulationHeaders } from "wreq-js"
import { BROWSER_PROFILE } from "./identity"
import { TransportFailure } from "./transport"
import { wreqTransport } from "./transport-wreq"

type Seen = { rawHeaders: string[]; method: string; body: string }

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections()
})

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, seen: Seen) => void,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const entry = {
        rawHeaders: request.rawHeaders,
        method: request.method ?? "",
        body: Buffer.concat(chunks).toString(),
      }
      seen.push(entry)
      handler(request, response, entry)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

async function failureOf(run: Promise<unknown>): Promise<TransportFailure> {
  try {
    await run
  } catch (error) {
    expect(error).toBeInstanceOf(TransportFailure)
    return error as TransportFailure
  }
  throw new Error("expected a failure")
}

const send = wreqTransport("macos")

describe("wreqTransport", () => {
  test("sends the headers as given, in order, and returns the answer", async () => {
    const { url, seen } = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "X-Mixed-Case": "Yes" })
      response.end('{"ok":true}')
    })
    const headers: [string, string][] = [
      ["sec-ch-ua-platform", '"macOS"'],
      ["authorization", "fake-token-value"],
      ["x-debug-options", "bugReporterEnabled"],
      ["user-agent", "Test/1.0"],
      ["accept", "*/*"],
      ["referer", "https://example.test/channels/@me"],
      ["accept-encoding", "gzip, deflate, br, zstd"],
      ["priority", "u=1, i"],
    ]

    const response = await send({ method: "GET", url: `${url}/path?x=1`, headers, timeoutMs: 5000 })

    expect(response).toEqual({
      status: 200,
      headers: expect.objectContaining({ "content-type": "application/json", "x-mixed-case": "Yes" }),
      body: '{"ok":true}',
    })
    const pairs: [string, string][] = []
    const raw = seen[0]!.rawHeaders
    for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i]!.toLowerCase(), raw[i + 1]!])
    const sent = pairs.filter(([name]) => !["host", "content-length", "connection"].includes(name))
    expect(sent).toEqual(headers)
  })

  test("sends the profile's navigation headers for a navigation, with only accept-language overridden", async () => {
    const { url, seen } = await serve((_request, response) => response.end("<html></html>"))
    const response = await send({
      method: "GET",
      url,
      headers: [["accept-language", "ja,ja;q=0.9,en-US;q=0.8,en;q=0.7"]],
      navigation: true,
      timeoutMs: 5000,
    })
    expect(response.body).toBe("<html></html>")

    const sent = new Map<string, string>()
    const raw = seen[0]!.rawHeaders
    for (let i = 0; i < raw.length; i += 2) sent.set(raw[i]!.toLowerCase(), raw[i + 1]!)
    const profile = getEmulationHeaders(BROWSER_PROFILE, "macos")
    expect(sent.get("sec-fetch-mode")).toBe("navigate")
    expect(sent.get("sec-fetch-dest")).toBe("document")
    expect(sent.get("upgrade-insecure-requests")).toBe("1")
    expect(sent.get("user-agent")).toBe(profile.get("user-agent")!)
    expect(sent.get("sec-ch-ua")).toBe(profile.get("sec-ch-ua")!)
    expect(sent.get("accept")).toBe(profile.get("accept")!)
    expect(sent.get("accept-language")).toBe("ja,ja;q=0.9,en-US;q=0.8,en;q=0.7")
    expect(sent.has("authorization")).toBe(false)
  })

  test("sends no navigation headers for a request that is not one", async () => {
    const { url, seen } = await serve((_request, response) => response.end())
    await send({ method: "GET", url, headers: [["accept", "*/*"]], timeoutMs: 5000 })
    const names = seen[0]!.rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase())
    expect(names).not.toContain("sec-fetch-mode")
    expect(names).not.toContain("upgrade-insecure-requests")
    expect(names).not.toContain("user-agent")
  })

  test("round-trips a body", async () => {
    const { url, seen } = await serve((_request, response, entry) => {
      response.writeHead(201)
      response.end(`echo:${entry.body}`)
    })
    const response = await send({
      method: "POST",
      url,
      headers: [["content-type", "application/json"]],
      body: '{"content":"héllo"}',
      timeoutMs: 5000,
    })
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.body).toBe('{"content":"héllo"}')
    expect(response.status).toBe(201)
    expect(response.body).toBe('echo:{"content":"héllo"}')
  })

  test("sends a binary body", async () => {
    const { url, seen } = await serve((_request, response) => response.end())
    await send({ method: "PUT", url, headers: [], body: new Uint8Array([104, 105]), timeoutMs: 5000 })
    expect(seen[0]!.body).toBe("hi")
  })

  test("does not follow a redirect", async () => {
    const { url, seen } = await serve((request, response) => {
      response.writeHead(302, { Location: "/elsewhere" })
      response.end()
      expect(request.url).toBe("/start")
    })
    const response = await send({ method: "GET", url: `${url}/start`, headers: [], timeoutMs: 5000 })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe("/elsewhere")
    expect(seen).toHaveLength(1)
  })

  test("decodes gzip and brotli bodies", async () => {
    const text = JSON.stringify({ message: "x".repeat(500) })
    const { url } = await serve((request, response) => {
      const gzip = request.url === "/gzip"
      response.writeHead(200, { "Content-Encoding": gzip ? "gzip" : "br" })
      response.end(gzip ? gzipSync(text) : brotliCompressSync(text))
    })
    for (const path of ["/gzip", "/br"]) {
      const response = await send({
        method: "GET",
        url: `${url}${path}`,
        headers: [["accept-encoding", "gzip, deflate, br, zstd"]],
        timeoutMs: 5000,
      })
      expect(response.body).toBe(text)
    }
  })

  test("a closed port fails before anything was sent", async () => {
    const { url } = await serve(() => {})
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
    const failure = await failureOf(send({ method: "GET", url, headers: [], timeoutMs: 5000 }))
    expect(failure.dispatched).toBe(false)
  })

  test("a name that does not resolve fails before anything was sent", async () => {
    const failure = await failureOf(
      send({ method: "GET", url: "http://no-such-host.invalid/", headers: [], timeoutMs: 5000 }),
    )
    expect(failure.dispatched).toBe(false)
  })

  test("a connection reset after connecting may have been sent", async () => {
    const { url } = await serve((request) => request.socket.destroy())
    const failure = await failureOf(send({ method: "POST", url, headers: [], body: "x", timeoutMs: 5000 }))
    expect(failure.dispatched).toBe(true)
  })

  test("a time-out may have been sent", async () => {
    const { url } = await serve(() => {})
    const failure = await failureOf(send({ method: "GET", url, headers: [], timeoutMs: 300 }))
    expect(failure.dispatched).toBe(true)
  })

  test("a signal aborted beforehand sends nothing", async () => {
    const { url, seen } = await serve((_request, response) => response.end())
    const failure = await failureOf(
      send({ method: "GET", url, headers: [], timeoutMs: 5000, signal: AbortSignal.abort() }),
    )
    expect(failure.dispatched).toBe(false)
    expect(seen).toHaveLength(0)
  })

  test("an abort while waiting may have been sent", async () => {
    const { url } = await serve(() => {})
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const failure = await failureOf(
      send({ method: "GET", url, headers: [], timeoutMs: 5000, signal: controller.signal }),
    )
    expect(failure.dispatched).toBe(true)
  })
})
