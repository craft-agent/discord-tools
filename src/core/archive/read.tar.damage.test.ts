import { afterEach, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { Scratch, readAll } from "./archive.testing"
import { tarBytes, tarGzBytes } from "./tar.testing"
import { ArchiveUnreadable, readEntries } from "./read"

const scratch = new Scratch()
afterEach(() => scratch.remove())

describe("readEntries: a damaged tar, a cancelled read", () => {
  test("refuses a header whose checksum is wrong", async () => {
    const bytes = tarBytes([{ name: "a.txt", data: "a" }])
    bytes[0] = bytes[0] ^ 0xff
    await expect(readAll(await scratch.write("a.tar", bytes), "tar")).rejects.toThrow(ArchiveUnreadable)
  })

  test("refuses a tar that is cut short", async () => {
    const bytes = tarBytes([{ name: "a.txt", data: "a".repeat(2000) }])
    await expect(readAll(await scratch.write("a.tar", bytes.subarray(0, 1200)), "tar")).rejects.toThrow(
      ArchiveUnreadable,
    )
    await expect(readAll(await scratch.write("b.tar", bytes.subarray(0, 100)), "tar")).rejects.toThrow(
      ArchiveUnreadable,
    )
  })

  test("refuses sizes written in base 256", async () => {
    const bytes = tarBytes([{ name: "a.txt", data: "a" }])
    bytes[124] = 0x80
    bytes.write("        ", 148, "latin1")
    const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0)
    bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1")
    await expect(readAll(await scratch.write("a.tar", bytes), "tar")).rejects.toThrow(ArchiveUnreadable)
  })

  test("refuses a gzip that is truncated or is not gzip", async () => {
    const gz = tarGzBytes([{ name: "a.txt", data: "abcdefgh".repeat(50_000) }])
    await expect(readAll(await scratch.write("a.tgz", gz.subarray(0, gz.length - 200)), "tar.gz")).rejects.toThrow(
      ArchiveUnreadable,
    )
    await expect(readAll(await scratch.write("b.tgz", Buffer.from("plain text, not gzip")), "tar.gz")).rejects.toThrow(
      ArchiveUnreadable,
    )
    await expect(readAll(await scratch.write("c.tgz", gzipSync("plain text, not a tar")), "tar.gz")).rejects.toThrow(
      ArchiveUnreadable,
    )
  })

  test("stops with the AbortError of an aborted signal", async () => {
    const path = await scratch.write("a.tar", tarBytes([{ name: "a.txt", data: "a" }]))
    const controller = new AbortController()
    controller.abort()
    const read = async () => {
      for await (const _ of readEntries(path, "tar", controller.signal)) void _
    }
    await expect(read()).rejects.toMatchObject({ name: "AbortError" })
  })

  test("closes the file when the consumer stops early", async () => {
    const path = await scratch.write(
      "a.tar.gz",
      tarGzBytes([
        { name: "a.txt", data: "a".repeat(200_000) },
        { name: "b.txt", data: "b" },
      ]),
    )
    for await (const entry of readEntries(path, "tar.gz")) {
      for await (const _ of entry.read()) break
      break
    }
    expect(await readAll(path, "tar.gz")).toHaveLength(2)
  })
})
