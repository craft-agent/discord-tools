import { afterEach, describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Scratch } from "./archive.testing"
import { beside, saveZip, tree, unpackZip } from "./unpack.testing"
import { unpackArchive } from "./unpack"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const CLASHING = "two entries have clashing names"

describe("unpackArchive: names that clash", () => {
  test("numbers a name an archive holds twice, and keeps both", async () => {
    const { folder } = await unpackZip(scratch, [
      { name: "dup.txt", data: "first" },
      { name: "dup.txt", data: "second" },
      { name: "dup.txt", data: "third" },
    ])
    expect(await tree(folder)).toEqual(["dup-2.txt", "dup-3.txt", "dup.txt"])
    expect(await readFile(join(folder, "dup.txt"), "utf8")).toBe("first")
    expect(await readFile(join(folder, "dup-2.txt"), "utf8")).toBe("second")
  })

  test("keeps both when names differ only by case, on any disk", async () => {
    const { folder, count } = await unpackZip(scratch, [
      { name: "Case.txt", data: "first" },
      { name: "case.txt", data: "second" },
    ])
    expect(count).toBe(2)
    const kept = await Promise.all((await readdir(folder)).map((name) => readFile(join(folder, name), "utf8")))
    expect(kept.sort()).toEqual(["first", "second"])
  })

  test("numbers a name without an extension and a dotfile", async () => {
    const { folder } = await unpackZip(scratch, [
      { name: "README", data: "1" },
      { name: "README", data: "2" },
      { name: ".env.example", data: "3" },
      { name: ".env.example", data: "4" },
    ])
    expect(await tree(folder)).toEqual([".env-2.example", ".env.example", "README", "README-2"])
  })

  test("refuses the 100th file of one name", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ name: "same.txt", data: `${i}` }))
    const path = await saveZip(scratch, items)
    await expect(unpackArchive(path, "pack.zip")).rejects.toThrow("too many entries share one name")
    expect(await beside(path)).toEqual(["pack.zip"])
  })

  test("refuses a file and a folder with one name, in either order, and keeps nothing", async () => {
    for (const items of [
      [
        { name: "a", data: "file" },
        { name: "a/b.txt", data: "inside" },
      ],
      [
        { name: "a/b.txt", data: "inside" },
        { name: "a", data: "file" },
      ],
      [{ name: "a", data: "file" }, { name: "a/" }, { name: "z.txt", data: "z" }],
    ]) {
      const path = await saveZip(scratch, items)
      await expect(unpackArchive(path, "pack.zip")).rejects.toThrow(CLASHING)
      expect(await beside(path)).toEqual(["pack.zip"])
      await scratch.remove()
    }
  })
})

describe("unpackArchive: names on disk", () => {
  test("replaces control and bidi characters", async () => {
    const { folder, files } = await unpackZip(scratch, [{ name: "two\nlines\u202e.txt", data: "x" }])
    expect(files).toEqual(["two_lines_.txt"])
    expect(await tree(folder)).toEqual(["two_lines_.txt"])
  })

  test("trims the whitespace around a part, and names an empty part _", async () => {
    const { files } = await unpackZip(scratch, [
      { name: " pad /  x.txt ", data: "1" },
      { name: "\u00a0\u00a0/y.txt", data: "2" },
    ])
    expect(files.sort()).toEqual(["_/y.txt", "pad/x.txt"])
  })

  test("never writes a part that is . or .. once cleaned", async () => {
    const path = await saveZip(scratch, [{ name: ".. /evil.txt", data: "x" }])
    const { folder, files } = await unpackArchive(path, "pack.zip")
    expect(files).toEqual(["_/evil.txt"])
    expect(await tree(folder)).toEqual(["_/", "_/evil.txt"])
    expect(await beside(path)).toEqual(["pack.unpacked/", "pack.unpacked/_/", "pack.unpacked/_/evil.txt", "pack.zip"])
  })

  test("cuts a long name to 200 characters and keeps a short extension", async () => {
    const { files } = await unpackZip(scratch, [
      { name: `${"a".repeat(300)}.txt`, data: "1" },
      { name: "b".repeat(300), data: "2" },
      { name: `${"c".repeat(300)}.${"x".repeat(30)}`, data: "3" },
    ])
    expect(files.map((file) => file.length).sort()).toEqual([200, 200, 200])
    expect(files.find((file) => file.startsWith("a"))?.endsWith("a.txt")).toBe(true)
  })

  test("cuts by UTF-8 bytes without splitting a character", async () => {
    const { folder, files } = await unpackZip(scratch, [
      { name: `${"漢".repeat(200)}.txt`, data: "1" },
      { name: "🙂".repeat(100), data: "2" },
      { name: `${"字".repeat(100)}.${"拡".repeat(10)}`, data: "3" },
    ])
    expect(files).toHaveLength(3)
    for (const file of files) {
      expect(Buffer.byteLength(file)).toBeLessThanOrEqual(200)
      expect(file).not.toContain("\ufffd")
    }
    const [cjk, emoji, longExtension] = files
    expect(cjk.startsWith("漢") && cjk.endsWith(".txt")).toBe(true)
    expect(emoji).toBe("🙂".repeat(50))
    expect(longExtension).toBe("字".repeat(66))
    expect(await tree(folder)).toEqual([...files].sort())
  })

  test("names the folder after the archive, cleaned the same way", async () => {
    const { folder } = await unpackZip(scratch, [{ name: "a.txt", data: "1" }], undefined, "My Files.ZIP")
    expect(folder.endsWith("/My Files.unpacked")).toBe(true)
  })
})
