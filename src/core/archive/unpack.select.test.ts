import { afterEach, describe, expect, test } from "bun:test"
import { Scratch } from "./archive.testing"
import { beside, saveZip, tree } from "./unpack.testing"
import { unpackArchive } from "./unpack"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const ITEMS = [
  { name: "docs/" },
  { name: "docs/a.txt", data: "alpha" },
  { name: "docs/deep/b.txt", data: "bravo" },
  { name: "other/c.txt", data: "charlie" },
  { name: "d.txt", data: "delta" },
  { name: "two\nlines.txt", data: "odd" },
]

async function unpackOnly(only: string[]) {
  const path = await saveZip(scratch, ITEMS)
  return { path, run: () => unpackArchive(path, "pack.zip", { only }) }
}

describe("unpackArchive: only", () => {
  test("unpacks a named file and the folders on the way to it, nothing else", async () => {
    const { run } = await unpackOnly(["docs/deep/b.txt"])
    const { folder, count } = await run()
    expect(count).toBe(1)
    expect(await tree(folder)).toEqual(["docs/", "docs/deep/", "docs/deep/b.txt"])
  })

  test("unpacks a folder with what is in it, with or without the closing slash", async () => {
    for (const want of ["docs", "docs/"]) {
      const { run } = await unpackOnly([want])
      const { folder } = await run()
      expect(await tree(folder)).toEqual(["docs/", "docs/a.txt", "docs/deep/", "docs/deep/b.txt"])
      await scratch.remove()
    }
  })

  test("takes several names, and one name at most once", async () => {
    const { run } = await unpackOnly(["d.txt", "other", "other/c.txt"])
    const { folder, count } = await run()
    expect(count).toBe(2)
    expect(await tree(folder)).toEqual(["d.txt", "other/", "other/c.txt"])
  })

  test("takes a name as the listing shows it", async () => {
    const { run } = await unpackOnly(["two?lines.txt"])
    expect((await run()).files).toEqual(["two_lines.txt"])
  })

  test("is not fooled by a name that only begins like a folder", async () => {
    const { run } = await unpackOnly(["doc"])
    await expect(run()).rejects.toThrow("it has no entry named 'doc'")
  })

  test("writes nothing when a name is missing, and says which", async () => {
    const { path, run } = await unpackOnly(["d.txt", "missing.txt"])
    await expect(run()).rejects.toThrow("it has no entry named 'missing.txt'")
    expect(await beside(path)).toEqual(["pack.zip"])
  })

  test("refuses a folder entry alone, since nothing is unpacked from it", async () => {
    const path = await saveZip(scratch, [{ name: "empty/" }, ...ITEMS])
    await expect(unpackArchive(path, "pack.zip", { only: ["empty"] })).rejects.toThrow("nothing was selected to unpack")
    expect(await beside(path)).toEqual(["pack.zip"])
  })

  test("refuses an empty list, an empty name and a name that is not text", async () => {
    const path = await saveZip(scratch, ITEMS)
    const refused = "entries must be a list of names from the archive's listing"
    for (const only of [[], [""], ["d.txt", 1], [null], "d.txt"]) {
      await expect(unpackArchive(path, "pack.zip", { only: only as string[] })).rejects.toThrow(refused)
    }
    expect(await beside(path)).toEqual(["pack.zip"])
  })
})
