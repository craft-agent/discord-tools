import { afterEach, describe, expect, test } from "bun:test"
import { readFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { Scratch } from "./archive.testing"
import { unpackArchive } from "./unpack"
import { beside, saveTar, saveZip, tree, unpackZip } from "./unpack.testing"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const MIB = 1024 * 1024
const ITEMS = [{ name: "docs/" }, { name: "docs/a.txt", data: "alpha" }, { name: "b.txt", data: "bravo!" }]

describe("unpackArchive: the destination", () => {
  test("numbers the folder while the name is taken", async () => {
    const path = await saveZip(scratch, ITEMS)
    const first = await unpackArchive(path, "pack.zip")
    const second = await unpackArchive(path, "pack.zip")
    const third = await unpackArchive(path, "pack.zip")
    expect([first, second, third].map((result) => result.folder.split("/").pop())).toEqual([
      "pack.unpacked",
      "pack-2.unpacked",
      "pack-3.unpacked",
    ])
  })

  test("leaves a folder that is already there alone", async () => {
    const path = await saveZip(scratch, ITEMS)
    await scratch.write("pack.unpacked", "in the way")
    const { folder } = await unpackArchive(path, "pack.zip")
    expect(folder.endsWith("pack-2.unpacked")).toBe(true)
    expect(await readFile(await scratch.path("pack.unpacked"), "utf8")).toBe("in the way")
  })
})

describe("unpackArchive: what is refused", () => {
  const hostile: Array<[string, () => Promise<string>, string]> = [
    [
      "a path that leaves the folder",
      () => saveZip(scratch, [{ name: "../evil.txt", data: "x" }]),
      "not a plain relative path",
    ],
    ["a link", () => saveTar(scratch, [{ name: "l", type: "2", link: "/etc/passwd" }]), "is a link"],
    ["a program", () => saveZip(scratch, [{ name: "run.exe", data: "x" }]), "is an archive or a program"],
    ["a program in disguise", () => saveZip(scratch, [{ name: "a.txt", data: "\x7fELF...." }]), "is a program"],
    ["an archive inside", () => saveZip(scratch, [{ name: "in.zip", data: "x" }]), "is an archive or a program"],
  ]

  for (const [what, save, why] of hostile) {
    test(`writes nothing for ${what}`, async () => {
      const path = await save()
      const file = path.split("/").pop()!
      await expect(unpackArchive(path, file)).rejects.toThrow(why)
      expect(await beside(path)).toEqual([file])
    })
  }

  test("refuses a link to the saved archive", async () => {
    const path = await saveZip(scratch, ITEMS)
    const link = await scratch.path("link.zip")
    await symlink(path, link)
    await expect(unpackArchive(link, "link.zip")).rejects.toThrow("it cannot be read as an archive")
    expect(await beside(path)).toEqual(["link.zip", "pack.zip"])
  })

  test("refuses a missing archive", async () => {
    const path = await scratch.path("gone.zip")
    await expect(unpackArchive(path, "gone.zip")).rejects.toThrow("it cannot be read as an archive")
  })

  test("refuses a zip bomb before writing anything", async () => {
    const bomb = [{ name: "zeros.dat", data: Buffer.alloc(3 * MIB), deflate: true, declared: 10 }]
    const path = await saveZip(scratch, bomb)
    await expect(unpackArchive(path, "pack.zip", { limits: { unpacked: MIB } })).rejects.toThrow("more than 1 MiB")
    expect(await beside(path)).toEqual(["pack.zip"])
  })

  test("refuses more entries than the cap", async () => {
    const path = await saveZip(scratch, ITEMS)
    await expect(unpackArchive(path, "pack.zip", { limits: { entries: 2 } })).rejects.toThrow("more than 2 entries")
    expect(await beside(path)).toEqual(["pack.zip"])
  })

  test("refuses an archive that is not what its name says", async () => {
    const path = await scratch.write("pack.zip", "plain text")
    await expect(unpackArchive(path, "pack.zip")).rejects.toThrow("not a zip archive")
    expect(await beside(path)).toEqual(["pack.zip"])
  })
})

describe("unpackArchive: marking and cancelling", () => {
  test("hands every file written to mark", async () => {
    const marked: string[][] = []
    const { folder } = await unpackZip(scratch, ITEMS, { mark: async (paths) => void marked.push(paths) })
    expect(marked).toHaveLength(1)
    expect(marked[0].sort()).toEqual([join(folder, "b.txt"), join(folder, "docs", "a.txt")])
  })

  test("is not failed by a mark that throws", async () => {
    const result = await unpackZip(scratch, ITEMS, {
      mark: async () => {
        throw new Error("no")
      },
    })
    expect(result.count).toBe(2)
    expect(await tree(result.folder)).toContain("b.txt")
  })

  test("rejects with the AbortError of an aborted signal and leaves no work folder", async () => {
    const path = await saveZip(scratch, ITEMS)
    const controller = new AbortController()
    controller.abort()
    const error = await unpackArchive(path, "pack.zip", { signal: controller.signal }).catch((caught: Error) => caught)
    expect((error as Error).name).toBe("AbortError")
    expect(await beside(path)).toEqual(["pack.zip"])
  })
})
