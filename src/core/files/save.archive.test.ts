import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { tarGzBytes } from "../archive/tar.testing"
import { zipBytes } from "../archive/zip.testing"
import { attachment, attachmentUrl, createFilesFixture, namesIn, saveArgs, type FilesFixture } from "./files.testing"

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
})

afterEach(() => f.dispose())

const ZIP = zipBytes([{ name: "a.txt", data: "alpha" }, { name: "docs/" }, { name: "docs/b.txt", data: "bravo!" }])
const TGZ = tarGzBytes([{ name: "x.txt", data: "xx" }])

/** Makes the message carry one archive of this name with these bytes. */
function carryArchive(name: string, bytes: Uint8Array = ZIP): void {
  f.carry({ attachments: [attachment(name, { content_type: "application/octet-stream" })] })
  f.host(attachmentUrl(name), [bytes])
}

describe("saving an archive", () => {
  test("inspects a zip, saves it packed and lists what is in it", async () => {
    carryArchive("pack.zip")
    const result = await f.save(saveArgs())
    expect(result.files).toEqual([
      {
        name: "pack.zip",
        kind: "attachment",
        status: "saved",
        path: join(f.folder, "pack.zip"),
        type: "application/octet-stream",
        size: ZIP.length,
        archive: { format: "zip", entries: 2, unpacked: 11, names: ["a.txt", "docs/b.txt"], more: 0 },
      },
    ])
    expect(result.note).toContain("`unpack: true`")
    expect(await namesIn(f.folder)).toEqual(["pack.zip"])
    expect((await stat(join(f.folder, "pack.zip"))).mode & 0o777).toBe(0o644)
    expect(await readFile(join(f.folder, "pack.zip"))).toEqual(Buffer.from(ZIP))
  })

  test("reads a .tar.gz and a .tgz too", async () => {
    for (const name of ["pack.tar.gz", "pack.tgz"]) {
      carryArchive(name, TGZ)
      const [file] = (await f.save(saveArgs())).files
      expect(file).toMatchObject({ status: "saved", archive: { format: "tar.gz", entries: 1, names: ["x.txt"] } })
    }
  })

  test("an archive whose bytes are another format than its name is refused", async () => {
    carryArchive("pack.zip", TGZ)
    const [file] = (await f.save(saveArgs())).files
    expect(file).toMatchObject({
      status: "refused",
      why: expect.stringContaining("the archive: its content is not a zip"),
    })
  })

  test.each([
    ["a program inside", zipBytes([{ name: "run.exe", data: "x" }]), "run.exe is an archive or a program"],
    ["an entry that leaves the folder", zipBytes([{ name: "../evil.txt", data: "x" }]), "not a plain relative path"],
    ["an archive inside", zipBytes([{ name: "in.zip", data: "x" }]), "in.zip is an archive or a program"],
    ["an ELF inside a plain name", zipBytes([{ name: "x.txt", data: "\x7fELF...." }]), "is a program"],
    ["nothing in it", zipBytes([{ name: "empty/" }]), "it contains no files"],
  ])("a hostile zip (%s) is refused, with the reason, and absent from the folder", async (_, bytes, why) => {
    carryArchive("pack.zip", bytes)
    const result = await f.save(saveArgs())
    expect(result.folder).toBeNull()
    expect(result.files[0]).toMatchObject({ status: "refused", why: expect.stringContaining(why) })
    expect(result.files[0]).not.toHaveProperty("path")
    expect(await namesIn(f.folder)).toEqual([])
    expect(await f.staged()).toEqual([])
  })

  test("scripts and key-like names in an archive someone sent are data, not a reason to refuse", async () => {
    carryArchive(
      "pack.zip",
      zipBytes([
        { name: "build.sh", data: "#!/bin/sh\n" },
        { name: ".env", data: "KEY=1" },
      ]),
    )
    expect((await f.save(saveArgs())).files[0]).toMatchObject({ status: "saved" })
  })
})

describe("unpacking", () => {
  beforeEach(() => carryArchive("pack.zip"))

  test("is not done unless asked, and nothing but the archive is written", async () => {
    await f.save(saveArgs())
    expect(await namesIn(f.folder)).toEqual(["pack.zip"])
  })

  test("with unpack, every file goes into a new folder beside the archive, which stays saved", async () => {
    const result = await f.save(saveArgs({ unpack: true }))
    const [file] = result.files
    expect(file).toMatchObject({
      status: "saved",
      path: join(f.folder, "pack.zip"),
      unpacked: {
        folder: join(f.folder, "pack.unpacked"),
        count: 2,
        unpacked: 11,
        files: ["a.txt", "docs/b.txt"],
        more: 0,
      },
    })
    expect(file).not.toHaveProperty("unpack_error")
    expect(await namesIn(f.folder)).toEqual(["pack.unpacked", "pack.zip"])
    expect(await readFile(join(f.folder, "pack.unpacked", "docs", "b.txt"), "utf8")).toBe("bravo!")
    expect(result.note).not.toContain("unpack: true")
  })

  test("with entries, only the names or folders asked for are written", async () => {
    const result = await f.save(saveArgs({ unpack: true, entries: ["docs"] }))
    expect(result.files[0]!.unpacked).toMatchObject({ count: 1, files: ["docs/b.txt"] })
    expect(await namesIn(join(f.folder, "pack.unpacked"))).toEqual(["docs"])
    const second = await f.save(saveArgs({ unpack: true, entries: ["a.txt"] }))
    expect(second.files[0]).toMatchObject({ status: "already", unpacked: { count: 1, files: ["a.txt"] } })
    expect(second.files[0]!.unpacked!.folder).toBe(join(f.folder, "pack-2.unpacked"))
  })

  test("an unknown entry is reported on the archive, which stays saved, and writes nothing", async () => {
    const result = await f.save(saveArgs({ unpack: true, entries: ["nope.txt"] }))
    expect(result.files[0]).toMatchObject({
      status: "saved",
      unpack_error: expect.stringContaining("it has no entry named 'nope.txt'"),
    })
    expect(result.files[0]).not.toHaveProperty("unpacked")
    expect(await namesIn(f.folder)).toEqual(["pack.zip"])
    expect(result.note).toContain("`unpack: true`")
  })

  test("an archive found already saved is unpacked too", async () => {
    await f.save(saveArgs())
    const result = await f.save(saveArgs({ unpack: true }))
    expect(result.files[0]).toMatchObject({ status: "already", unpacked: { count: 2 } })
    expect(await namesIn(f.folder)).toEqual(["pack.unpacked", "pack.zip"])
  })

  test("an archive saved under a number is unpacked beside it under the same number", async () => {
    await f.save(saveArgs())
    f.host(attachmentUrl("pack.zip"), [zipBytes([{ name: "other.txt", data: "o" }])])
    const result = await f.save(saveArgs({ unpack: true }))
    expect(result.files[0]).toMatchObject({ status: "saved", path: join(f.folder, "pack-2.zip") })
    expect(result.files[0]!.unpacked!.folder).toBe(join(f.folder, "pack-2.unpacked"))
  })

  test("a refused archive is not unpacked, and files that are not archives are left alone", async () => {
    f.carry({ attachments: [attachment("bad.zip"), attachment("note.txt")] })
    f.host(attachmentUrl("bad.zip"), [zipBytes([{ name: "run.exe", data: "x" }])])
    f.host(attachmentUrl("note.txt"), ["hello"])
    const result = await f.save(saveArgs({ unpack: true }))
    expect(result.files.map((file) => file.status)).toEqual(["refused", "saved"])
    expect(result.files.every((file) => file.unpacked === undefined && file.unpack_error === undefined)).toBe(true)
    expect(await namesIn(f.folder)).toEqual(["note.txt"])
  })
})
