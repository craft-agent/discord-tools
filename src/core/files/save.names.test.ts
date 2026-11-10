import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { attachment, attachmentUrl, createFilesFixture, namesIn, saveArgs, type FilesFixture } from "./files.testing"

let f: FilesFixture

beforeEach(async () => {
  f = await createFilesFixture()
})

afterEach(() => f.dispose())

/** The link of the file number `where`, a plain path the media host's answer can be keyed by. */
const linkOf = (where: string) => attachmentUrl(`${where}/file`)

/** Makes the message carry files of these names, the one at index `i` served with `bodies[i]`. */
function carryNamed(names: string[], bodies: string[] = names.map(() => "x")): void {
  f.carry({ attachments: names.map((name, i) => attachment(name, { url: linkOf(String(i)) })) })
  bodies.forEach((body, i) => f.host(linkOf(String(i)), [body]))
}

describe("the names files are saved under", () => {
  test("a name is cleaned: base name, odd characters and edges", async () => {
    carryNamed(["../../etc/evil name?*.txt", "C:\\dir\\ .hidden.png . ", "???"])
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => [file.name, file.status])).toEqual([
      ["evil name_.txt", "saved"],
      ["hidden.png", "saved"],
      ["_", "saved"],
    ])
    expect(await namesIn(f.folder)).toEqual(["_", "evil name_.txt", "hidden.png"])
  })

  test("a long CJK name is cut to 200 bytes and keeps its extension", async () => {
    carryNamed([`${"写真".repeat(80)}.png`])
    const [file] = (await f.save(saveArgs())).files
    expect(file!.name).toBe(`${"写真".repeat(32)}写.png`)
    expect(Buffer.byteLength(file!.name)).toBeLessThanOrEqual(200)
    expect(await namesIn(f.folder)).toEqual([file!.name])
  })

  test("an empty name is file-<n>", async () => {
    carryNamed(["//", "b.txt"])
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => file.name)).toEqual(["file-1", "b.txt"])
  })
})

describe("a name that is taken", () => {
  beforeEach(() => carryNamed(["cat.png"], ["meow"]))

  test("a file of the same name and bytes from an earlier call is already there, and stays as it was", async () => {
    const first = await f.save(saveArgs())
    const second = await f.save(saveArgs())
    expect(second.folder).toBe(f.folder)
    expect(second.files).toEqual([
      {
        name: "cat.png",
        kind: "attachment",
        status: "already",
        path: first.files[0]!.path!,
        type: "image/png",
        size: 4,
      },
    ])
    expect(await namesIn(f.folder)).toEqual(["cat.png"])
  })

  test("other bytes get the next free number, and the file that was there is never replaced", async () => {
    await f.save(saveArgs())
    f.host(linkOf("0"), ["woof!"])
    const second = await f.save(saveArgs())
    expect(second.files[0]).toMatchObject({ name: "cat.png", status: "saved", path: join(f.folder, "cat-2.png") })
    f.host(linkOf("0"), ["quack"])
    const third = await f.save(saveArgs())
    expect(third.files[0]).toMatchObject({ status: "saved", path: join(f.folder, "cat-3.png") })
    expect(await namesIn(f.folder)).toEqual(["cat-2.png", "cat-3.png", "cat.png"])
    expect(await readFile(join(f.folder, "cat.png"), "utf8")).toBe("meow")
    expect(await readFile(join(f.folder, "cat-2.png"), "utf8")).toBe("woof!")
  })

  test("bytes already saved under a later number are already there", async () => {
    await f.save(saveArgs())
    f.host(linkOf("0"), ["woof!"])
    await f.save(saveArgs())
    const third = await f.save(saveArgs())
    expect(third.files[0]).toMatchObject({ status: "already", path: join(f.folder, "cat-2.png") })
    expect(await namesIn(f.folder)).toEqual(["cat-2.png", "cat.png"])
  })

  test("a file of the same name that someone else put there is never replaced", async () => {
    await mkdir(f.folder, { recursive: true })
    await writeFile(join(f.folder, "cat.png"), "mine")
    const result = await f.save(saveArgs())
    expect(result.files[0]).toMatchObject({ status: "saved", path: join(f.folder, "cat-2.png") })
    expect(await readFile(join(f.folder, "cat.png"), "utf8")).toBe("mine")
  })

  test("a folder of the same name makes the next number, not a failure", async () => {
    await mkdir(join(f.folder, "cat.png"), { recursive: true })
    const result = await f.save(saveArgs())
    expect(result.files[0]).toMatchObject({ status: "saved", path: join(f.folder, "cat-2.png") })
  })
})

describe("two files of one name in one call", () => {
  test("the second is numbered, though the bytes are the same", async () => {
    carryNamed(["a.png", "a.png"], ["same", "same"])
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => [file.status, file.path])).toEqual([
      ["saved", join(f.folder, "a.png")],
      ["saved", join(f.folder, "a-2.png")],
    ])
  })

  test("names that differ only in case count as one name", async () => {
    carryNamed(["A.png", "a.png"], ["one", "two"])
    const result = await f.save(saveArgs())
    expect(result.files.map((file) => file.path)).toEqual([join(f.folder, "A.png"), join(f.folder, "a-2.png")])
  })
})
