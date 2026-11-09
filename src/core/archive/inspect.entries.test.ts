import { afterEach, describe, expect, test } from "bun:test"
import { Scratch } from "./archive.testing"
import { inspectTar, inspectZip } from "./inspect.testing"
import { ZIP_EXTERNAL } from "./zip.testing"
import { ArchiveRefused, shownName } from "./inspect"

const scratch = new Scratch()
afterEach(() => scratch.remove())

const DATA = "data"

async function zipMessage(items: Parameters<typeof inspectZip>[1]): Promise<string> {
  const error = await inspectZip(scratch, items).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ArchiveRefused)
  return (error as Error).message
}

describe("inspectArchive: names", () => {
  test.each([
    ["../escape.txt"],
    ["a/../../escape.txt"],
    ["/etc/passwd"],
    ["a\\b.txt"],
    ["C:\\windows\\x.txt"],
    ["c:x.txt"],
    ["a\0b.txt"],
    [".."],
    ["."],
  ])("refuses %p as not a plain relative path", async (name) => {
    const message = await zipMessage([{ name, data: DATA }])
    expect(message).toEndWith("is not a plain relative path")
  })

  test("passes the ./ folder a tar of the current folder starts with", async () => {
    const report = await inspectZip(scratch, [{ name: "./" }, { name: "./a.txt", data: DATA }])
    expect(report?.entries).toBe(1)
  })

  test("refuses an empty name", async () => {
    expect(await zipMessage([{ name: "", data: DATA }])).toBe(" is not a plain relative path")
  })

  test("passes ./a/, __MACOSX/ and names with dots that are not parent folders", async () => {
    const report = await inspectZip(scratch, [
      { name: "./a/" },
      { name: "./a/b.txt", data: DATA },
      { name: "__MACOSX/" },
      { name: "__MACOSX/._b.txt", data: DATA },
      { name: "a//c..txt", data: DATA },
      { name: "..hidden", data: DATA },
    ])
    expect(report?.entries).toBe(4)
  })

  test.each([["inner.zip"], ["inner.JAR"], ["setup.exe"], ["lib/inner.tar.gz"], ["x.rar"], ["x.app"], ["a/b.dmg"]])(
    "refuses %s as an archive or a program, scripts allowed or not",
    async (name) => {
      expect(await zipMessage([{ name, data: DATA }])).toBe(`${name} is an archive or a program`)
      const refused = inspectZip(scratch, [{ name, data: DATA }], { allowScripts: false, scanKeys: false })
      await expect(refused).rejects.toThrow("is an archive or a program")
    },
  )

  test("judges the name of a file, not of its folder", async () => {
    expect(
      await inspectZip(scratch, [{ name: "build.js/" }, { name: "build.js/readme.txt", data: DATA }]),
    ).toMatchObject({
      entries: 1,
    })
  })
})

describe("inspectArchive: links, special files, encryption", () => {
  test("refuses a zip symbolic link", async () => {
    const message = await zipMessage([
      { name: "ok.txt", data: DATA },
      { name: "link", data: "ok.txt", external: ZIP_EXTERNAL.link },
    ])
    expect(message).toBe("link is a link or a special file")
  })

  test("refuses a zip special file", async () => {
    expect(await zipMessage([{ name: "fifo", external: ZIP_EXTERNAL.fifo }])).toBe("fifo is a link or a special file")
  })

  test.each([
    ["a symbolic link", "2"],
    ["a hard link", "1"],
    ["a FIFO", "6"],
    ["a character device", "3"],
    ["a block device", "4"],
    ["a sparse file", "S"],
  ])("refuses a tar entry that is %s", async (_label, type) => {
    const refused = inspectTar(scratch, [
      { name: "a.txt", data: DATA },
      { name: "odd", type, link: "a.txt" },
    ])
    await expect(refused).rejects.toThrow("odd is a link or a special file")
  })

  test("refuses an encrypted zip entry before reading it", async () => {
    expect(await zipMessage([{ name: "secret.txt", data: DATA, encrypted: true, method: 99 }])).toBe(
      "secret.txt is encrypted, so it cannot be checked",
    )
  })

  test("checks the path before the type, and the type before the encryption", async () => {
    expect(await zipMessage([{ name: "../x", external: ZIP_EXTERNAL.link, encrypted: true }])).toContain(
      "plain relative path",
    )
    expect(await zipMessage([{ name: "x", external: ZIP_EXTERNAL.link, encrypted: true }])).toContain(
      "link or a special",
    )
  })
})

describe("inspectArchive: names in messages", () => {
  test("cleans control, bidi and invisible characters, so a message is one line", async () => {
    const name = "evil\nname\r\u202eexe.txt\u2028x/../y\u200b\u0000\u007f"
    const message = await zipMessage([{ name, data: DATA }])
    expect(message).toBe("evil?name??exe.txt?x/../y??? is not a plain relative path")
    expect(message).not.toMatch(/[\n\r\u2028\u2029\u202e]/)
  })

  test("cuts a long name", async () => {
    const message = await zipMessage([{ name: `../${"x".repeat(200)}`, data: DATA }])
    expect(message).toBe(`../${"x".repeat(77)}… is not a plain relative path`)
  })

  test("shownName cuts by code points and keeps the rest", () => {
    expect(shownName("😀".repeat(5), 3)).toBe("😀😀😀…")
    expect(shownName("abc", 3)).toBe("abc")
    expect(shownName("a\u0085b\ufeffc\ufffa")).toBe("a?b?c?")
  })

  test("lists cleaned names", async () => {
    const report = await inspectTar(scratch, [{ name: "line\nbreak\u202e.txt", data: DATA }])
    expect(report?.names).toEqual(["line?break?.txt"])
  })
})
