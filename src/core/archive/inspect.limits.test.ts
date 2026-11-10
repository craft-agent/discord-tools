import { afterEach, describe, expect, test } from "bun:test"
import { Scratch } from "./archive.testing"
import { inspectTar, inspectZip } from "./inspect.testing"
import { RECEIVED, type InspectOptions } from "./inspect"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const MIB = 1024 * 1024
const limited = (limits: NonNullable<InspectOptions["limits"]>): InspectOptions => ({ ...RECEIVED, limits })
const numbered = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `f${i}.txt`, data: `${i}` }))

describe("inspectArchive: unpacked size", () => {
  test("refuses a zip bomb, counted from the bytes read and not from the declared size", async () => {
    const bomb = [{ name: "zeros.dat", data: Buffer.alloc(3 * MIB), deflate: true, declared: 10 }]
    await expect(inspectZip(scratch, bomb, limited({ unpacked: MIB }))).rejects.toThrow(
      "it would unpack to more than 1 MiB",
    )
  })

  test("refuses a stored zip entry whose declared size lies in the same way", async () => {
    const lying = [{ name: "zeros.dat", data: Buffer.alloc(3 * MIB), declared: 1 }]
    await expect(inspectZip(scratch, lying, limited({ unpacked: MIB }))).rejects.toThrow("more than 1 MiB")
  })

  test("refuses by the declared size before reading anything", async () => {
    const declared = [{ name: "a.txt", data: "small", declared: 5 * MIB, crc: 1 }]
    await expect(inspectZip(scratch, declared, limited({ unpacked: MIB }))).rejects.toThrow("more than 1 MiB")
  })

  test("refuses a tar.gz bomb and a tar bomb", async () => {
    const bomb = [{ name: "zeros.dat", data: Buffer.alloc(3 * MIB) }]
    await expect(inspectTar(scratch, bomb, limited({ unpacked: MIB }), "a.tar.gz")).rejects.toThrow("more than 1 MiB")
    await expect(inspectTar(scratch, bomb, limited({ unpacked: MIB }), "a.tar")).rejects.toThrow("more than 1 MiB")
  })

  test("adds the entries up", async () => {
    const two = [
      { name: "a.dat", data: Buffer.alloc(MIB * 0.6) },
      { name: "b.dat", data: Buffer.alloc(MIB * 0.6) },
    ]
    await expect(inspectZip(scratch, two, limited({ unpacked: MIB }))).rejects.toThrow("more than 1 MiB")
    expect((await inspectZip(scratch, two, limited({ unpacked: 2 * MIB })))?.unpacked).toBe(Math.floor(MIB * 0.6) * 2)
  })
})

describe("inspectArchive: entries and empty archives", () => {
  test("counts every entry, folders included, against the cap", async () => {
    const items = [{ name: "folder/" }, ...numbered(3)]
    await expect(inspectZip(scratch, items, limited({ entries: 3 }))).rejects.toThrow("it has more than 3 entries")
    await expect(
      inspectTar(
        scratch,
        items.map((i) => ({ ...i, type: i.name.endsWith("/") ? "5" : "0" })),
        limited({ entries: 3 }),
      ),
    ).rejects.toThrow("it has more than 3 entries")
    expect((await inspectZip(scratch, items, limited({ entries: 4 })))?.entries).toBe(3)
  })

  test("refuses an archive with no entries, with folders only, or with empty files only", async () => {
    await expect(inspectZip(scratch, [])).rejects.toThrow("it contains no files")
    await expect(inspectZip(scratch, [{ name: "a/" }, { name: "a/b/" }])).rejects.toThrow("it contains no files")
    await expect(inspectZip(scratch, [{ name: "empty.txt" }])).rejects.toThrow("it contains no files")
    await expect(inspectTar(scratch, [])).rejects.toThrow("not a tar archive")
    await expect(inspectTar(scratch, [{ name: "a/", type: "5" }], RECEIVED, "a.tgz")).rejects.toThrow(
      "it contains no files",
    )
  })
})

describe("inspectArchive: the listing", () => {
  test("lists the first names with data, in order, and counts the rest", async () => {
    const items = [{ name: "dir/" }, { name: "empty.txt" }, ...numbered(5)]
    const report = await inspectZip(scratch, items, limited({ listing: 2 }))
    expect(report).toMatchObject({ entries: 5, names: ["f0.txt", "f1.txt"], more: 3 })
  })

  test("lists everything under the default cap of 50 names", async () => {
    const report = await inspectZip(scratch, numbered(60))
    expect(report?.names).toHaveLength(50)
    expect(report).toMatchObject({ entries: 60, more: 10 })
  })

  test("cuts long names in the listing", async () => {
    const report = await inspectZip(scratch, [{ name: "abcdefghijkl.txt", data: "x" }], limited({ nameShown: 10 }))
    expect(report?.names).toEqual(["abcdefghij…"])
  })
})
