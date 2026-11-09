import { afterEach, describe, expect, test } from "bun:test"

import { Scratch, readAll } from "./archive.testing"
import { tarBytes, tarGzBytes } from "./tar.testing"
import { ArchiveUnreadable, readEntries } from "./read"

const scratch = new Scratch()
afterEach(() => scratch.remove())

describe("readEntries: tar", () => {
  test("reads every kind of entry with its data", async () => {
    const path = await scratch.write(
      "a.tar",
      tarBytes([
        { name: "file.txt", data: "hello" },
        { name: "nul.txt", data: "x", type: "\0" },
        { name: "contiguous.txt", data: "y", type: "7" },
        { name: "folder/", type: "5" },
        { name: "soft", type: "2", link: "file.txt" },
        { name: "hard", type: "1", link: "file.txt" },
        { name: "dev", type: "3" },
        { name: "pipe", type: "6" },
        { name: "sparse", type: "S", data: "zz" },
        { name: "last.txt", data: "z".repeat(1000) },
      ]),
    )
    const entries = await readAll(path, "tar")
    expect(entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ["file.txt", "file", 5],
      ["nul.txt", "file", 1],
      ["contiguous.txt", "file", 1],
      ["folder/", "directory", 0],
      ["soft", "link", 0],
      ["hard", "link", 0],
      ["dev", "special", 0],
      ["pipe", "special", 0],
      ["sparse", "special", 2],
      ["last.txt", "file", 1000],
    ])
    expect(entries[0].data.toString()).toBe("hello")
    expect(entries[9].data.toString()).toBe("z".repeat(1000))
  })

  test("applies the path and size of a pax header to the next entry only", async () => {
    const long = `${"deep/".repeat(40)}file.txt`
    const path = await scratch.write(
      "a.tar",
      tarBytes([
        { name: "unused", pax: { path: long, comment: "ignored" }, data: "first" },
        { name: "second.txt", data: "second" },
      ]),
    )
    const entries = await readAll(path, "tar")
    expect(entries.map((e) => e.name)).toEqual([long, "second.txt"])
    expect(entries.map((e) => e.data.toString())).toEqual(["first", "second"])
  })

  test("leaves a global pax header out of the entries", async () => {
    const path = await scratch.write(
      "a.tar",
      tarBytes([
        { name: "global", type: "g", data: "7 a=b\n" },
        { name: "a.txt", data: "a" },
      ]),
    )
    expect((await readAll(path, "tar")).map((e) => e.name)).toEqual(["a.txt"])
  })

  test("reads a GNU long name, and ignores a GNU long link name", async () => {
    const long = `${"long-folder-name/".repeat(10)}file.txt`
    const path = await scratch.write(
      "a.tar",
      tarBytes([
        { name: "link-name", type: "K", data: "ignored\0" },
        { name: long, longName: true, data: "data" },
        { name: "short.txt", data: "s" },
      ]),
    )
    const entries = await readAll(path, "tar")
    expect(entries.map((e) => e.name)).toEqual([long, "short.txt"])
    expect(entries[0].data.toString()).toBe("data")
  })

  test("joins the ustar prefix and the name", async () => {
    const path = await scratch.write("a.tar", tarBytes([{ name: "file.txt", prefix: "some/folder" }]))
    expect((await readAll(path, "tar"))[0].name).toBe("some/folder/file.txt")
  })

  test("reads a gzipped tar", async () => {
    const path = await scratch.write("a.tgz", tarGzBytes([{ name: "a.txt", data: "a".repeat(100_000) }]))
    const [entry] = await readAll(path, "tar.gz")
    expect(entry.data.length).toBe(100_000)
  })

  test("skips the data of entries that are not read", async () => {
    const path = await scratch.write(
      "a.tar",
      tarBytes([
        { name: "a.txt", data: "a".repeat(1300) },
        { name: "b.txt", data: "b" },
      ]),
    )
    const names: string[] = []
    for await (const entry of readEntries(path, "tar")) names.push(entry.name)
    expect(names).toEqual(["a.txt", "b.txt"])
  })

  test("lets an entry be read once", async () => {
    const path = await scratch.write("a.tar", tarBytes([{ name: "a.txt", data: "a" }, { name: "b.txt" }]))
    const entries = readEntries(path, "tar")[Symbol.asyncIterator]()
    const first = (await entries.next()).value
    for await (const _ of first.read()) void _
    expect(() => first.read()).toThrow()
    await entries.next()
    await entries.return?.()
  })
})
