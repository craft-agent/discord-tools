import { afterEach, describe, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { Scratch } from "./archive.testing"
import { inspectTar, inspectZip } from "./inspect.testing"
import { tarBytes, tarGzBytes } from "./tar.testing"
import { zipBytes } from "./zip.testing"
import { ARCHIVE_LIMITS, ArchiveRefused, RECEIVED, inspectArchive } from "./inspect"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const FILES = [{ name: "a.txt", data: "hello" }, { name: "folder/" }, { name: "folder/b.txt", data: "world!" }]

describe("inspectArchive: the report", () => {
  test("reports the files with data of a zip", async () => {
    const report = await inspectZip(scratch, [...FILES, { name: "empty.txt" }])
    expect(report).toEqual({
      format: "zip",
      entries: 2,
      unpacked: 11,
      names: ["a.txt", "folder/b.txt"],
      more: 0,
    })
  })

  test("reads deflated zip entries", async () => {
    const report = await inspectZip(scratch, [{ name: "a.txt", data: "text ".repeat(10_000), deflate: true }])
    expect(report).toMatchObject({ entries: 1, unpacked: 50_000 })
  })

  test("passes each tar format with its label", async () => {
    expect(await inspectTar(scratch, FILES, RECEIVED, "a.tar")).toMatchObject({
      format: "tar",
      entries: 2,
      unpacked: 11,
    })
    expect(await inspectTar(scratch, FILES, RECEIVED, "a.tar.gz")).toMatchObject({ format: "tar.gz", entries: 2 })
    expect(await inspectTar(scratch, FILES, RECEIVED, "A.TGZ")).toMatchObject({ format: "tar.gz", entries: 2 })
  })

  test("takes the names of pax and GNU long-name entries", async () => {
    const long = `${"deep-folder/".repeat(12)}file.txt`
    const report = await inspectTar(scratch, [
      { name: "x", pax: { path: "pax/file.txt" }, data: "p" },
      { name: long, longName: true, data: "l" },
    ])
    expect(report?.names).toEqual(["pax/file.txt", `${long.slice(0, 80)}…`])
  })

  test("leaves a name that is not an archive name to the caller", async () => {
    const path = await scratch.write("photo.jpg", zipBytes(FILES))
    expect(await inspectArchive(path, "photo.jpg", RECEIVED)).toBeUndefined()
    expect(await inspectArchive(path, "data.tar.bz2", RECEIVED)).toBeUndefined()
    expect(await inspectArchive(path, "data.rar", RECEIVED)).toBeUndefined()
  })
})

describe("inspectArchive: the content must match the name", () => {
  test("refuses content that is another format than the name says", async () => {
    const zip = await scratch.write("a.bin", zipBytes(FILES))
    await expect(inspectArchive(zip, "photo.tar", RECEIVED)).rejects.toThrow(
      "its content is not a tar archive, whatever the name says",
    )
    await expect(inspectArchive(zip, "photo.tgz", RECEIVED)).rejects.toThrow("not a tar.gz archive")
    const tar = await scratch.write("b.bin", tarBytes(FILES))
    await expect(inspectArchive(tar, "photo.zip", RECEIVED)).rejects.toThrow("not a zip archive")
    const gz = await scratch.write("c.bin", tarGzBytes(FILES))
    await expect(inspectArchive(gz, "photo.tar", RECEIVED)).rejects.toThrow("not a tar archive")
    const text = await scratch.write("d.bin", "just text")
    await expect(inspectArchive(text, "photo.zip", RECEIVED)).rejects.toThrow("not a zip archive")
  })

  test("refuses a missing file, a damaged archive and a link as a refusal, not a crash", async () => {
    await expect(inspectArchive(await scratch.path("missing.zip"), "missing.zip", RECEIVED)).rejects.toThrow(
      new ArchiveRefused("it cannot be read as an archive"),
    )
    const path = await scratch.write("a.zip", zipBytes([{ name: "a.txt", data: "hello", crc: 1 }]))
    await expect(inspectArchive(path, "a.zip", RECEIVED)).rejects.toBeInstanceOf(ArchiveRefused)
    await expect(inspectArchive(path, "a.zip", RECEIVED)).rejects.toThrow("it cannot be read as an archive")
    const link = join(path, "..", "link.zip")
    await symlink(path, link)
    await expect(inspectArchive(link, "link.zip", RECEIVED)).rejects.toThrow("it cannot be read as an archive")
    const cut = await scratch.write("b.zip", zipBytes(FILES).subarray(0, 40))
    await expect(inspectArchive(cut, "b.zip", RECEIVED)).rejects.toThrow("it cannot be read as an archive")
  })

  test("keeps the default limits", () => {
    expect(ARCHIVE_LIMITS).toEqual({ entries: 500, unpacked: 500 * 1024 * 1024, listing: 50, nameShown: 80 })
  })
})
