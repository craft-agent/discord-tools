import { afterEach, describe, expect, test } from "bun:test"
import { Scratch, readAll } from "./archive.testing"
import { ZIP_EXTERNAL, zipBytes } from "./zip.testing"
import { ArchiveUnreadable, readEntries } from "./read"

const scratch = new Scratch()
afterEach(() => scratch.remove())

async function zipAt(bytes: Uint8Array): Promise<string> {
  return scratch.write("a.zip", bytes)
}

describe("readEntries: zip", () => {
  test("reads stored and deflated entries back", async () => {
    const big = "line of text\n".repeat(100_000)
    const path = await zipAt(
      zipBytes([
        { name: "stored.txt", data: "stored data" },
        { name: "deflated.txt", data: big, deflate: true },
        { name: "empty.txt" },
        { name: "folder/" },
      ]),
    )
    const entries = await readAll(path, "zip")
    expect(entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ["stored.txt", "file", 11],
      ["deflated.txt", "file", big.length],
      ["empty.txt", "file", 0],
      ["folder/", "directory", 0],
    ])
    expect(entries[0].data.toString()).toBe("stored data")
    expect(entries[1].data.toString()).toBe(big)
    expect(entries.every((e) => !e.encrypted)).toBe(true)
  })

  test("yields data in pieces of at most 1 MiB", async () => {
    const path = await zipAt(zipBytes([{ name: "big.bin", data: Buffer.alloc(3 * 1024 * 1024, 7) }]))
    const sizes: number[] = []
    for await (const entry of readEntries(path, "zip")) for await (const piece of entry.read()) sizes.push(piece.length)
    expect(sizes).toEqual([1024 * 1024, 1024 * 1024, 1024 * 1024])
  })

  test("tells the kind from the external attributes and the name", async () => {
    const path = await zipAt(
      zipBytes([
        { name: "a", external: ZIP_EXTERNAL.regular },
        { name: "b/", external: ZIP_EXTERNAL.directory },
        { name: "c", external: ZIP_EXTERNAL.link, data: "target" },
        { name: "d", external: ZIP_EXTERNAL.fifo },
        { name: "e", external: ZIP_EXTERNAL.directory },
      ]),
    )
    expect((await readAll(path, "zip")).map((e) => e.kind)).toEqual([
      "file",
      "directory",
      "link",
      "special",
      "directory",
    ])
  })

  test("reports the encrypted flag, and cannot read such an entry", async () => {
    const path = await zipAt(zipBytes([{ name: "secret.txt", data: "x", encrypted: true }]))
    for await (const found of readEntries(path, "zip")) {
      expect(found.encrypted).toBe(true)
      await expect(found.read()[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ArchiveUnreadable)
    }
  })

  test("decodes names as UTF-8", async () => {
    const path = await zipAt(zipBytes([{ name: "日本語.txt", data: "x" }]))
    expect((await readAll(path, "zip"))[0].name).toBe("日本語.txt")
  })
})
