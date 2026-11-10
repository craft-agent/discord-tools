import { afterEach, beforeEach, expect, test } from "bun:test"
import { headerOf } from "../discord/fake-discord.testing"
import { UPLOAD_TIMEOUT_MS, UPLOADS_TIMEOUT_MS } from "./upload"
import { createUploadFixture, DESTINATION, RESERVE_PATH, slotOf, type UploadFixture } from "./upload.testing"

let f: UploadFixture

beforeEach(async () => {
  f = await createUploadFixture()
})

afterEach(() => f.dispose())

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

test("reserves one slot per file, with its name and size, from the chat's page", async () => {
  const files = await f.prepare(["one", "three"])
  await f.upload(files)
  const [reservation] = f.harness.discord.api
  expect(reservation).toMatchObject({ method: "POST", path: RESERVE_PATH })
  expect(JSON.parse(reservation!.body!)).toEqual({
    files: [
      { id: "0", filename: "f0.txt", file_size: 3 },
      { id: "1", filename: "f1.txt", file_size: 5 },
    ],
  })
  expect(headerOf(reservation!, "referer")).toBe(`https://discord.com${DESTINATION.referer}`)
})

test("uploads each copy, in order, to its slot's URL, and names them for the message", async () => {
  const files = await f.prepare(["one", "three", "second"])
  expect(await f.upload(files)).toEqual([
    { id: "0", filename: "f0.txt", uploaded_filename: "uploads/0/stored.bin" },
    { id: "1", filename: "f1.txt", uploaded_filename: "uploads/1/stored.bin" },
    { id: "2", filename: "f2.txt", uploaded_filename: "uploads/2/stored.bin" },
  ])
  const puts = f.puts()
  expect(puts.map((request) => request.url)).toEqual([0, 1, 2].map((i) => slotOf(i).upload_url))
  expect(puts.map((request) => text(request.bytes))).toEqual(["one", "three", "second"])
  expect(headerOf(puts[0]!, "referer")).toBe(`https://discord.com${DESTINATION.referer}`)
  expect(f.harness.discord.requests.map((request) => request.method)).toEqual(["POST", "PUT", "PUT", "PUT"])
})

test("matches slots by id, whatever order Discord lists them in, and takes numeric ids", async () => {
  f.harness.discord.route("POST", RESERVE_PATH, {
    status: 200,
    json: { attachments: [slotOf(2), slotOf(0, { id: 0 }), { ...slotOf(5) }, slotOf(1)] },
  })
  const files = await f.prepare(["a", "b", "c"])
  const attached = await f.upload(files)
  expect(attached.map((item) => item.uploaded_filename)).toEqual([0, 1, 2].map((i) => slotOf(i).upload_filename))
  expect(text(f.puts()[2]!.bytes)).toBe("c")
  expect(f.puts().map((request) => request.path)).toEqual(["/up/0/file.bin", "/up/1/file.bin", "/up/2/file.bin"])
})

test("gives each upload the time limit, less what the uploads have already used", async () => {
  f.harness.discord.route("PUT", "/up/0/file.bin", () => {
    f.harness.advance(500_000)
    return { status: 200 }
  })
  const files = await f.prepare(["a", "b"])
  await f.upload(files)
  const used = 500_000 + 1100
  expect(f.puts().map((request) => request.timeoutMs)).toEqual([UPLOAD_TIMEOUT_MS, UPLOADS_TIMEOUT_MS - used])
})

test("uploads in time when just over the least time is left", async () => {
  f.harness.discord.route("PUT", "/up/0/file.bin", () => {
    f.harness.advance(UPLOADS_TIMEOUT_MS - 10_000 - 1100)
    return { status: 200 }
  })
  const files = await f.prepare(["a", "b"])
  expect(await f.upload(files)).toHaveLength(2)
  expect(f.puts()[1]!.timeoutMs).toBe(10_000)
})
