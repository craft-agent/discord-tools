import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { attachment, attachmentUrl, createFilesFixture, namesIn, saveArgs, type FilesFixture } from "./files.testing"

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
})

afterEach(() => f.dispose())

/** Makes the message carry one attachment of this name and declared type, served with `body` and the response `headers`. */
function carryOne(name: string, body: string | Uint8Array, declared?: string, headers: Record<string, string> = {}) {
  f.carry({ attachments: [attachment(name, { content_type: declared, size: 20 })] })
  f.host(attachmentUrl(name), [body], headers)
}

/** The one file of a save, which must not have reached the folder. */
async function refusedFile() {
  const result = await f.save(saveArgs())
  expect(result.folder).toBeNull()
  expect(await namesIn(f.folder)).toEqual([])
  expect(await f.staged()).toEqual([])
  return result.files[0]!
}

describe("a file refused by its name or declared type, before any request", () => {
  test.each([
    ["a program by name", "setup.exe", "image/png"],
    ["a script by name", "run.sh", "text/plain"],
    ["an installer by name", "tool.pkg", "text/plain"],
    ["a disk image by name", "disk.dmg", "text/plain"],
    ["an archive the module cannot read", "pack.rar", "text/plain"],
    ["a .tar.bz2", "pack.tar.bz2", "application/x-bzip2"],
    ["a .tar.xz", "pack.tar.xz", "application/x-xz"],
    ["a .gz alone", "notes.gz", "application/gzip"],
    ["a program by declared type", "data", "application/x-msdownload"],
    ["a script by declared type", "notes.txt", "application/x-sh"],
  ])("%s", async (_, name, declared) => {
    carryOne(name, "bytes", declared)
    const file = await refusedFile()
    expect(file).toMatchObject({
      name,
      status: "refused",
      why: expect.stringMatching(/^it is an archive or a program$/),
    })
    expect(f.media.requests).toEqual([])
  })

  test("a name with its edges trimmed is judged as it is saved", async () => {
    carryOne("setup.exe . ", "bytes", "image/png")
    expect(await refusedFile()).toMatchObject({ name: "setup.exe", status: "refused" })
    expect(f.media.requests).toEqual([])
  })

  test("the other files go on", async () => {
    f.carry({ attachments: [attachment("setup.exe"), attachment("ok.png")] })
    f.host(attachmentUrl("ok.png"), ["fine"])
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => [file.name, file.status])).toEqual([
      ["setup.exe", "refused"],
      ["ok.png", "saved"],
    ])
    expect(result.folder).toBe(f.folder)
    expect(await namesIn(f.folder)).toEqual(["ok.png"])
    expect(f.media.requests).toHaveLength(1)
  })
})

describe("a file refused by its bytes, after the download", () => {
  test("an ELF program named .png is refused and never saved", async () => {
    carryOne("photo.png", "\x7fELF\x02\x01\x01 and the rest", "image/png", { "content-type": "image/png" })
    expect(await refusedFile()).toMatchObject({ name: "photo.png", status: "refused", why: "it is a program" })
    expect(f.media.requests).toHaveLength(1)
  })

  test("a Mach-O and a Windows program are refused too", async () => {
    const windows = new Uint8Array(0x80)
    windows.set([0x4d, 0x5a], 0)
    windows[0x3c] = 0x40
    windows.set([0x50, 0x45, 0, 0], 0x40)
    for (const bytes of [Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]), windows]) {
      carryOne("photo.png", bytes, "image/png")
      expect(await refusedFile()).toMatchObject({ status: "refused", why: "it is a program" })
    }
  })

  test("a script on its own is refused", async () => {
    carryOne("notes.txt", "#!/bin/sh\necho hi\n", "text/plain")
    expect(await refusedFile()).toMatchObject({ status: "refused", why: "it is a script" })
  })

  test("an archive under another name is refused", async () => {
    carryOne("photo.png", "PK\x03\x04rest", "image/png")
    expect(await refusedFile()).toMatchObject({ status: "refused", why: "it is an archive" })
  })

  test("a type the host answers with is judged as well as the one Discord declared", async () => {
    carryOne("notes.txt", "text", "text/plain", { "content-type": "application/x-msdownload" })
    expect(await refusedFile()).toMatchObject({ status: "refused", why: "it is an archive or a program" })
  })

  test("a plain text file whose first line looks harmless is saved", async () => {
    carryOne("notes.txt", "hello\n#!/not/first", "text/plain")
    const result = await f.save(saveArgs())
    expect(result.files[0]).toMatchObject({ status: "saved" })
    expect(await readFile(join(f.folder, "notes.txt"), "utf8")).toBe("hello\n#!/not/first")
  })
})

describe("a file that Discord's host does not give", () => {
  test("a declared size over the limit is too_large, without a request", async () => {
    f.carry({ attachments: [attachment("big.png", { size: 1024 * 1024 + 1 })] })
    const file = await refusedFile()
    expect(file).toMatchObject({ status: "too_large", size: 1024 * 1024 + 1, why: expect.stringContaining("1 MB") })
    expect(f.media.requests).toEqual([])
  })

  test("a Content-Length over the limit, and a body that grows past it, are too_large", async () => {
    carryOne("a.png", "x", "image/png", { "content-length": String(1024 * 1024 + 1) })
    expect((await refusedFile()).status).toBe("too_large")
    carryOne("b.png", new Uint8Array(1024 * 1024 + 1), "image/png")
    expect((await refusedFile()).status).toBe("too_large")
  })

  test("a body of exactly the limit is saved", async () => {
    carryOne("exact.png", new Uint8Array(1024 * 1024), "image/png")
    expect((await f.save(saveArgs())).files[0]).toMatchObject({ status: "saved", size: 1024 * 1024 })
  })

  test("an answer that is not a 2xx is missing, with the status", async () => {
    f.carry({ attachments: [attachment("gone.png")] })
    const file = await refusedFile()
    expect(file).toMatchObject({ status: "missing", why: "Discord's media host answered 404" })
  })

  test("a failure below HTTP is failed", async () => {
    carryOne("a.png", "x", "image/png")
    f.media.failNext("boom")
    const file = await refusedFile()
    expect(file).toMatchObject({ status: "failed", why: expect.stringContaining("boom") })
  })

  test("a link off Discord's hosts is refused without a request", async () => {
    f.carry({ attachments: [attachment("a.png", { url: "https://evil.example/a.png" })] })
    expect(await refusedFile()).toMatchObject({ status: "refused", why: "not on Discord's media hosts" })
    expect(f.media.requests).toEqual([])
  })

  test("the files after one that failed are still saved", async () => {
    f.carry({ attachments: [attachment("a.png"), attachment("b.png")] })
    f.host(attachmentUrl("b.png"), ["bb"])
    f.media.failNext("boom")
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => file.status)).toEqual(["failed", "saved"])
    expect(await namesIn(f.folder)).toEqual(["b.png"])
  })
})
