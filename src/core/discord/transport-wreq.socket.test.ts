import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { type IncomingMessage, type Server, createServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import type { SocketEvent, TransportSocket } from "./transport"
import { wreqSocket } from "./transport-wreq"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8

type Upgrade = { request: IncomingMessage; socket: Socket; received: string[]; closeCodes: number[] }

const servers: Server[] = []
const opened: TransportSocket[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((socket) => socket.close(1000).catch(() => {})))
  for (const server of servers.splice(0)) server.closeAllConnections()
})

function frame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126
      ? [0x80 | opcode, payload.length]
      : [0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]
  return Buffer.concat([Buffer.from(head), payload])
}

/** The text of the client's masked frames, and the code of its close frame; only frames under 126 bytes. */
function readClientFrames(upgrade: Upgrade, data: Buffer): void {
  for (let at = 0; at < data.length;) {
    const opcode = data[at]! & 0x0f
    const length = data[at + 1]! & 0x7f
    const mask = data.subarray(at + 2, at + 6)
    const payload = Buffer.from(data.subarray(at + 6, at + 6 + length).map((byte, i) => byte ^ mask[i % 4]!))
    if (opcode === OP_TEXT) upgrade.received.push(payload.toString())
    if (opcode === OP_CLOSE) {
      upgrade.closeCodes.push(payload.readUInt16BE(0))
      upgrade.socket.end(frame(OP_CLOSE, payload.subarray(0, 2)))
    }
    at += 6 + length
  }
}

async function serve(onUpgrade: (upgrade: Upgrade) => void): Promise<{ url: string; upgrades: Upgrade[] }> {
  const upgrades: Upgrade[] = []
  const server = createServer()
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const accept = createHash("sha1")
      .update(String(request.headers["sec-websocket-key"]) + WEBSOCKET_GUID)
      .digest("base64")
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const upgrade: Upgrade = { request, socket, received: [], closeCodes: [] }
    socket.on("data", (data: Buffer) => readClientFrames(upgrade, data))
    upgrades.push(upgrade)
    onUpgrade(upgrade)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/?v=9`, upgrades }
}

async function open(url: string, headers: [string, string][] = []): Promise<TransportSocket> {
  const socket = await wreqSocket("macos")({ url, headers, maxMessageSize: 1024 * 1024 })
  opened.push(socket)
  return socket
}

async function events(socket: TransportSocket, count: number): Promise<SocketEvent[]> {
  const seen: SocketEvent[] = []
  while (seen.length < count) seen.push(await socket.next())
  return seen
}

describe("wreqSocket", () => {
  test("delivers what the server sends at once, in order, and then the close", async () => {
    const { url } = await serve(({ socket }) => {
      socket.write(Buffer.concat([frame(OP_TEXT, Buffer.from("hello")), frame(OP_BINARY, Buffer.from([1, 2, 3]))]))
      socket.write(frame(OP_CLOSE, Buffer.from([0x0f, 0xa4, ...Buffer.from("no")])))
    })
    const socket = await open(url)
    const seen = await events(socket, 3)
    expect(seen[0]).toEqual({ type: "message", data: "hello" })
    expect(seen[1]!.type === "message" && Buffer.from(seen[1]!.data as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    expect(seen[2]).toEqual({ type: "close", code: 4004, reason: "no" })
    expect(await socket.next()).toEqual(seen[2]!)
  })

  test("sends the headers it is given and closes with the code it is given", async () => {
    const { url, upgrades } = await serve(({ socket }) => socket.write(frame(OP_TEXT, Buffer.from("hello"))))
    const socket = await open(url, [
      ["origin", "https://discord.com"],
      ["pragma", "no-cache"],
    ])
    expect(await socket.next()).toEqual({ type: "message", data: "hello" })
    socket.send("identify")
    await new Promise((resolve) => setTimeout(resolve, 50))
    await socket.close(1000)
    const upgrade = upgrades[0]!
    expect(upgrade.request.headers.origin).toBe("https://discord.com")
    expect(upgrade.request.headers.pragma).toBe("no-cache")
    expect(upgrade.request.headers.authorization).toBeUndefined()
    expect(upgrade.received).toEqual(["identify"])
    expect(upgrade.closeCodes).toEqual([1000])
    expect((await socket.next()).type).toBe("close")
  })

  test("reports a connection that cannot be made as a close with the failure", async () => {
    const { url } = await serve(() => {})
    const dead = url.replace(/:\d+\//, ":1/")
    const socket = await open(dead)
    const event = await socket.next()
    expect(event).toMatchObject({ type: "close", code: 1006, error: expect.any(String) })
  })

  test("ends a message larger than it accepts", async () => {
    const { url } = await serve(({ socket }) => {
      const big = Buffer.alloc(200_000, 0x61)
      socket.write(
        Buffer.concat([
          Buffer.from([0x82, 127]),
          Buffer.from(new BigUint64Array([BigInt(big.length)]).buffer).reverse(),
          big,
        ]),
      )
    })
    const socket = await wreqSocket("macos")({ url, headers: [], maxMessageSize: 1000 })
    opened.push(socket)
    expect((await socket.next()).type).toBe("close")
  })
})
