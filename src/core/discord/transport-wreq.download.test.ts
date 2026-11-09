import { afterEach, describe, expect, test } from "bun:test"
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { TransportFailure } from "./transport"
import { wreqDownload } from "./transport-wreq"

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections()
})

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

const download = wreqDownload("macos")

describe("wreqDownload", () => {
  test("resolves at the headers and hands out the decoded body", async () => {
    const text = "x".repeat(5000)
    const url = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Encoding": "gzip" })
      response.end(gzipSync(text))
    })
    const response = await download({ method: "GET", url, headers: [["accept-encoding", "gzip"]], timeoutMs: 5000 })
    expect(response.status).toBe(200)
    expect(response.headers["content-type"]).toBe("image/png")
    expect(await collect(response.body)).toBe(text)
    await response.cancel()
  })

  test("does not follow a redirect", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(302, { Location: "/elsewhere" })
      response.end()
    })
    const response = await download({ method: "GET", url, headers: [], timeoutMs: 5000 })
    expect(response.status).toBe(302)
    expect(response.headers.location).toBe("/elsewhere")
    expect(await collect(response.body)).toBe("")
  })

  test("sends only the headers it is given", async () => {
    let raw: string[] = []
    const url = await serve((request, response) => {
      raw = request.rawHeaders
      response.end()
    })
    await download({ method: "GET", url, headers: [["accept", "*/*"]], timeoutMs: 5000 })
    const names = raw.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase())
    expect(names).not.toContain("user-agent")
    expect(names).not.toContain("sec-fetch-mode")
  })

  test("cancel gives up on the rest of the body", async () => {
    const url = await serve((_request, response) => {
      response.write("first")
    })
    const response = await download({ method: "GET", url, headers: [], timeoutMs: 5000 })
    await response.cancel()
    await response.cancel()
  })

  test("a body that fails while it is read rejects with a TransportFailure", async () => {
    const url = await serve((request, response) => {
      response.writeHead(200, { "Content-Length": "10000000" })
      response.write(Buffer.alloc(2 * 1024 * 1024, 0x61))
      setTimeout(() => request.socket.destroy(), 50)
    })
    const response = await download({ method: "GET", url, headers: [], timeoutMs: 5000 })
    expect(await collect(response.body).catch((error: unknown) => error)).toBeInstanceOf(TransportFailure)
  })

  test("an abort while the body is read rejects with a TransportFailure", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": "10000000" })
      response.write(Buffer.alloc(2 * 1024 * 1024, 0x61))
    })
    const controller = new AbortController()
    const response = await download({ method: "GET", url, headers: [], timeoutMs: 5000, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect(await collect(response.body).catch((error: unknown) => error)).toBeInstanceOf(TransportFailure)
  })

  test("a signal aborted beforehand sends nothing", async () => {
    let seen = 0
    const url = await serve((_request, response) => {
      seen += 1
      response.end()
    })
    const failure = await download({
      method: "GET",
      url,
      headers: [],
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportFailure)
    expect((failure as TransportFailure).dispatched).toBe(false)
    expect(seen).toBe(0)
  })
})
