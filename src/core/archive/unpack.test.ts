import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Scratch } from "./archive.testing"
import { unpackArchive } from "./unpack"
import { beside, modeOf, saveTar, saveZip, tree, unpackZip } from "./unpack.testing"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const ITEMS = [{ name: "docs/" }, { name: "docs/a.txt", data: "alpha" }, { name: "b.txt", data: "bravo!" }]

describe("unpackArchive: what is written", () => {
  test("unpacks a zip beside the archive, which stays as it was", async () => {
    const path = await saveZip(scratch, ITEMS)
    const before = await readFile(path)
    const result = await unpackArchive(path, "pack.zip")
    expect(result.folder).toBe(join(await scratch.path(""), "pack.unpacked"))
    expect(await tree(result.folder)).toEqual(["b.txt", "docs/", "docs/a.txt"])
    expect(await readFile(join(result.folder, "docs", "a.txt"), "utf8")).toBe("alpha")
    expect(await readFile(path)).toEqual(before)
    expect(await beside(path)).toEqual([
      "pack.unpacked/",
      "pack.unpacked/b.txt",
      "pack.unpacked/docs/",
      "pack.unpacked/docs/a.txt",
      "pack.zip",
    ])
  })

  test("counts and lists what it wrote", async () => {
    const result = await unpackZip(scratch, ITEMS)
    expect(result).toMatchObject({ count: 2, unpacked: 11, more: 0 })
    expect(result.files.sort()).toEqual(["b.txt", "docs/a.txt"])
  })

  test("cuts a long listing and says how many files it left out", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: `${i}` }))
    const result = await unpackZip(scratch, items, { limits: { listing: 2 } })
    expect(result).toMatchObject({ count: 5, more: 3 })
    expect(result.files).toEqual(["f0.txt", "f1.txt"])
  })

  test("unpacks a tar and a tar.gz, also one that starts with ./", async () => {
    const items = [
      { name: "./", type: "5" },
      { name: "./d/", type: "5" },
      { name: "./d/x.txt", data: "xx" },
    ]
    for (const [file, base] of [
      ["pack.tar", "pack"],
      ["pack.tar.gz", "pack"],
      ["other.tgz", "other"],
    ]) {
      const result = await unpackArchive(await saveTar(scratch, items, file), file)
      expect(result.folder.endsWith(`${base}.unpacked`)).toBe(true)
      expect(await tree(result.folder)).toEqual(["d/", "d/x.txt"])
      await scratch.remove()
    }
  })

  test("writes no execute bit: files 0644, folders 0755", async () => {
    const { folder } = await unpackZip(scratch, ITEMS)
    expect(await modeOf(join(folder, "b.txt"))).toBe(0o644)
    expect(await modeOf(join(folder, "docs", "a.txt"))).toBe(0o644)
    expect(await modeOf(join(folder, "docs"))).toBe(0o755)
  })

  test("writes the same modes under a strict umask", async () => {
    const path = await saveZip(scratch, ITEMS)
    const previous = process.umask(0o077)
    try {
      const { folder } = await unpackArchive(path, "pack.zip")
      expect(await modeOf(folder)).toBe(0o755)
      expect(await modeOf(join(folder, "docs"))).toBe(0o755)
      expect(await modeOf(join(folder, "b.txt"))).toBe(0o644)
    } finally {
      process.umask(previous)
    }
  })

  test("writes empty files and folders the archive lists", async () => {
    const { folder, count } = await unpackZip(scratch, [{ name: "empty/" }, { name: "empty.txt" }, ...ITEMS])
    expect(count).toBe(3)
    expect(await tree(folder)).toContain("empty/")
    expect(await tree(folder)).toContain("empty.txt")
  })

  test("refuses a name that is not a zip or tar archive", async () => {
    const path = await scratch.write("notes.txt", "hello")
    await expect(unpackArchive(path, "notes.txt")).rejects.toThrow("it is not an archive this can unpack")
    expect(await beside(path)).toEqual(["notes.txt"])
  })
})
