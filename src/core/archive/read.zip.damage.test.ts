import { afterEach, describe, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { Scratch, readAll } from "./archive.testing"
import { zipBytes } from "./zip.testing"
import { ArchiveUnreadable, readEntries } from "./read"

const scratch = new Scratch()
afterEach(() => scratch.remove())

async function zipAt(bytes: Uint8Array): Promise<string> {
  return scratch.write("a.zip", bytes)
}

describe("readEntries: a damaged zip, a cancelled read", () => {
  test("fails a corrupt CRC when the data has been read", async () => {
    const path = await zipAt(zipBytes([{ name: "a.txt", data: "hello", crc: 1 }]))
    await expect(readAll(path, "zip")).rejects.toThrow(ArchiveUnreadable)
  })

  test("fails a deflate stream that is damaged", async () => {
    const bytes = zipBytes([{ name: "a.txt", data: "hello hello hello hello", deflate: true }])
    bytes[30 + "a.txt".length] = 0xff
    await expect(readAll(await zipAt(bytes), "zip")).rejects.toThrow(ArchiveUnreadable)
  })

  test("refuses a compression method other than stored and deflate", async () => {
    const path = await zipAt(zipBytes([{ name: "a.txt", data: "hello", method: 12 }]))
    await expect(readAll(path, "zip")).rejects.toThrow(ArchiveUnreadable)
  })

  test("refuses zip64 markers", async () => {
    const bytes = zipBytes([{ name: "a.txt", data: "hello" }])
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 10)
    await expect(readAll(await zipAt(bytes), "zip")).rejects.toThrow(ArchiveUnreadable)
  })

  test("refuses what is not a zip, or is cut short", async () => {
    await expect(readAll(await zipAt(Buffer.from("not a zip at all")), "zip")).rejects.toThrow(ArchiveUnreadable)
    const bytes = zipBytes([{ name: "a.txt", data: "hello" }])
    await expect(readAll(await zipAt(bytes.subarray(0, bytes.length - 10)), "zip")).rejects.toThrow(ArchiveUnreadable)
  })

  test("refuses a file that is not regular, and a link to one", async () => {
    const path = await zipAt(zipBytes([{ name: "a.txt", data: "hello" }]))
    await expect(readAll(join(path, ".."), "zip")).rejects.toThrow(ArchiveUnreadable)
    const link = join(path, "..", "link.zip")
    await symlink(path, link)
    await expect(readAll(link, "zip")).rejects.toThrow()
  })

  test("stops with the AbortError of an aborted signal", async () => {
    const path = await zipAt(zipBytes([{ name: "a.txt", data: "hello" }]))
    const controller = new AbortController()
    controller.abort()
    const read = async () => {
      for await (const _ of readEntries(path, "zip", controller.signal)) void _
    }
    await expect(read()).rejects.toMatchObject({ name: "AbortError" })
  })

  test("closes the file when the consumer stops early", async () => {
    const path = await zipAt(
      zipBytes([
        { name: "a.txt", data: "a".repeat(50_000), deflate: true },
        { name: "b.txt", data: "b" },
      ]),
    )
    for await (const entry of readEntries(path, "zip")) {
      for await (const _ of entry.read()) break
      break
    }
    expect(await readAll(path, "zip")).toHaveLength(2)
  })
})
